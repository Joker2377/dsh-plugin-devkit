/**
 * What is actually running, compared with what the profile says should be.
 *
 * `application=applied`, a green CI and a passing `plugin_doctor` all stop short
 * of the Host loading the module. This module joins three sources per bundle:
 * the profile's declarations, the installed files, and the Cordis loader's live
 * fiber phase when the caller can reach it (only a running Host can).
 *
 * Read-only: it opens files and reads loader state. It never imports a bundle,
 * so inspecting one runs none of its code.
 *
 * @module dsh-plugin-devkit/inspect
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { configFindings, evaluateRequirements, normalizeRel } from './checks.js'
import { readProfile } from './profile.js'
import { parsePatch } from './yaml.js'

/** Mirrors Cordis FiberState, a const enum that does not exist at runtime. Index = state. */
const FIBER_PHASES = ['pending', 'loading', 'active', 'failed', null, 'unloading']
const MARK = { error: '✗', warn: '⚠', info: '·' }
const OFFICIAL_PREFIX = '@deepseek-ai/'

/**
 * Project the Cordis loader to plain rows, the way the Host's plugin inventory does.
 *
 * @param {any} loader the `loader` service, or undefined outside a running Host
 * @returns {Promise<Array<{ entryId: string, moduleName: string, enabled: boolean, phase: string | null, diagnostic?: string }> | undefined>}
 */
export async function readLiveEntries(loader) {
	if (typeof loader?.entries !== 'function') return undefined
	const rows = []
	for (const entry of loader.entries()) {
		if (entry.options?.group) continue
		const fiber = entry.fiber
		const phase = fiber === undefined ? null : FIBER_PHASES[fiber.state] ?? null
		const row = { entryId: String(entry.id), moduleName: String(entry.options?.name ?? ''), enabled: !entry.disabled, phase }
		if (phase === 'failed') {
			try {
				await fiber.await()
			} catch (error) {
				row.diagnostic = error instanceof Error ? error.message : String(error)
			}
		}
		rows.push(row)
	}
	return rows
}

/**
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readText(path) {
	try {
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

/**
 * @param {string | undefined} text
 * @returns {Record<string, any> | undefined}
 */
function parseManifest(text) {
	try {
		// Some published packages ship a UTF-8 BOM, which JSON.parse rejects.
		const value = JSON.parse(String(text).replace(/^﻿/, ''))
		return typeof value === 'object' && value !== null ? value : undefined
	} catch {
		return undefined
	}
}

/**
 * The file `main` or `exports['.']` names, as the Host would load it.
 *
 * @param {Record<string, any>} manifest
 * @returns {string}
 */
function entryPath(manifest) {
	const root = typeof manifest.exports === 'object' && manifest.exports !== null ? manifest.exports['.'] : manifest.exports
	const target = typeof root === 'string' ? root : root?.import ?? root?.default ?? manifest.main ?? 'lib/index.js'
	return normalizeRel(target)
}

/**
 * Which live rows belong to this bundle: its module name, a submodule of it, or
 * an id its patch inserted (a patch may name a module by relative path).
 *
 * @param {Array<{ entryId: string, moduleName: string }>} live
 * @param {string} name
 * @param {Set<string>} insertIds
 */
function matchLive(live, name, insertIds) {
	return live.filter((row) => row.moduleName === name || row.moduleName.startsWith(`${name}/`) || insertIds.has(row.entryId))
}

/**
 * Turn matched live rows into a state and findings. A failed row wins over an
 * active one, because a bundle is only as loaded as its worst entry.
 *
 * @param {Array<{ moduleName: string, enabled: boolean, phase: string | null, diagnostic?: string }>} rows
 * @param {string} name
 * @returns {{ state: string, findings: object[] }}
 */
function liveVerdict(rows, name) {
	const failed = rows.find((row) => row.phase === 'failed')
	if (failed !== undefined) {
		return {
			state: 'failed',
			findings: [{
				level: 'error',
				code: 'inspect/load-failed',
				message: `${name} 載入失敗：${failed.diagnostic ?? '沒有診斷訊息'}`,
				hint: '修好後要 bump 版本，先 remove_bundle 再 install_bundle。',
			}],
		}
	}
	const enabled = rows.filter((row) => row.enabled)
	if (rows.length > 0 && enabled.length === 0) {
		return { state: 'disabled', findings: [{ level: 'info', code: 'inspect/disabled', message: `${name} 已安裝，但目前停用。` }] }
	}
	if (enabled.some((row) => row.phase === 'active')) return { state: 'active', findings: [] }
	if (enabled.some((row) => row.phase === 'pending' || row.phase === 'loading')) return { state: 'loading', findings: [] }
	return {
		state: 'not-loaded',
		findings: [{
			level: 'warn',
			code: 'inspect/not-loaded',
			message: `${name} 在 bundle 清單裡，但 loader 裡沒有執行中的 entry。`,
			hint: '重載或重啟 App。回 restart-required 的安裝要重啟才會生效。',
		}],
	}
}

/**
 * Inspect one bundle the profile knows about.
 *
 * @param {object} input
 * @param {string} input.name
 * @param {any} input.profile output of `readProfile()`
 * @param {string} [input.hostVersion]
 * @param {Array<object>} [input.live]
 * @returns {Promise<object>}
 */
async function inspectBundle({ name, profile, hostVersion, live }) {
	const dependency = profile.dependencies[name]
	const selected = profile.bundles.includes(name)
	if (dependency === undefined && name.startsWith(OFFICIAL_PREFIX)) {
		return { name, source: 'official', selected, state: 'official', findings: [] }
	}

	const findings = []
	const row = { name, source: dependency?.raw ?? '（未宣告）', selected, findings }
	if (dependency === undefined) {
		return {
			...row,
			state: 'not-installed',
			findings: [{ level: 'error', code: 'inspect/not-installed', message: `${name} 在 bundle 清單裡，但沒有宣告依賴。`, hint: '用 plugin_manager 重新安裝，或把它移出 bundle 清單。' }],
		}
	}

	const dir = dependency.kind === 'link' ? dependency.resolvedPath : join(profile.root, 'node_modules', name)
	if (!(await isDirectory(dir))) {
		const linked = dependency.kind === 'link'
		return {
			...row,
			state: 'not-installed',
			findings: [{
				level: 'error',
				code: linked ? 'inspect/link-missing' : 'inspect/not-installed',
				message: linked ? `${name} 的 link 目標不存在：${dir}` : `${name} 已宣告，但 ${dir} 不存在。`,
				hint: linked ? '目錄被搬移或刪除等於卸載。放回原位，或用新路徑重裝。' : '用 plugin_manager 重新安裝。',
			}],
		}
	}

	const manifest = parseManifest(await readText(join(dir, 'package.json')))
	if (manifest === undefined) {
		return { ...row, state: 'not-installed', findings: [{ level: 'error', code: 'inspect/manifest-unreadable', message: `讀不懂 ${join(dir, 'package.json')}。` }] }
	}
	if (typeof manifest.version === 'string') row.version = manifest.version

	const patchRel = manifest.dsh?.bundle?.patch
	const patchText = typeof patchRel === 'string' ? await readText(join(dir, normalizeRel(patchRel))) : undefined
	if (patchText === undefined) {
		findings.push({
			level: 'warn',
			code: 'inspect/patch-missing',
			message: `${name} 沒有可讀的 bundle patch${typeof patchRel === 'string' ? `（${patchRel}）` : ''}，選進清單也不會插入任何一列。`,
		})
	}
	if (!selected) {
		findings.push({
			level: 'warn',
			code: 'inspect/not-selected',
			message: `${name} 已安裝，但不在 dsh.profile.bundles 裡，所以不會載入。`,
			hint: '用 plugin_manager 啟用，或移除這個依賴。',
		})
	}

	if (hostVersion !== undefined) {
		for (const unmet of evaluateRequirements(manifest, hostVersion)) {
			findings.push({
				level: selected ? 'error' : 'warn',
				code: 'inspect/compat-unmet',
				message: `${name}@${manifest.version} 的 ${unmet.field} 是 ${unmet.range}，不接受 ${hostVersion}。`,
				hint: '等 upstream 發新版，或明確授權版本豁免。',
			})
		}
	}

	const entryContent = await readText(join(dir, entryPath(manifest)))
	// Unverifiable Configs are normal in third-party bundles; only certain failures belong here.
	if (entryContent !== undefined) findings.push(...configFindings(entryContent).filter((finding) => finding.level === 'error'))

	if (live === undefined) return { ...row, state: 'unknown', liveEntries: [] }
	const matched = matchLive(live, name, new Set(parsePatch(patchText).inserts.map((insert) => insert.id)))
	if (!selected && matched.length === 0) return { ...row, state: 'not-selected', liveEntries: [] }
	const verdict = liveVerdict(matched, name)
	findings.push(...verdict.findings)
	return { ...row, state: verdict.state, liveEntries: matched.map((entry) => entry.entryId) }
}

/**
 * Compare a profile with what is really there.
 *
 * @param {object} [input]
 * @param {string} [input.profileDir]
 * @param {string} [input.name] one bundle; default is all of them
 * @param {string} [input.hostVersion]
 * @param {Array<object>} [input.live] output of `readLiveEntries()`
 * @returns {Promise<object>}
 */
export async function inspectProfile({ profileDir, name, hostVersion, live } = {}) {
	const profile = await readProfile(profileDir)
	const base = { root: profile.root, installed: profile.installed, hostVersion, liveChecked: live !== undefined }
	if (!profile.installed) return { ...base, ok: false, counts: { error: 1, warn: 0, info: 0 }, bundles: [], findings: [{ level: 'error', code: 'inspect/profile-unreadable', message: `讀不到 profile：${profile.root}`, hint: '用 profileDir 指定含 package.json 的 profile 目錄。' }] }

	const known = [...new Set([...Object.keys(profile.dependencies), ...profile.bundles])].sort()
	const names = name === undefined ? known : known.filter((candidate) => candidate === name)
	if (name !== undefined && names.length === 0) {
		return { ...base, ok: false, counts: { error: 1, warn: 0, info: 0 }, bundles: [], findings: [{ level: 'error', code: 'inspect/unknown-bundle', message: `profile 裡沒有 ${name}。` }] }
	}

	const bundles = []
	for (const candidate of names) bundles.push(await inspectBundle({ name: candidate, profile, hostVersion, live }))

	// Failures outside this profile's own bundles (official or transitive rows) still count.
	const findings = []
	if (name === undefined && live !== undefined) {
		const claimed = new Set(bundles.flatMap((bundle) => bundle.liveEntries ?? []))
		for (const row of live) {
			if (row.phase !== 'failed' || claimed.has(row.entryId)) continue
			findings.push({ level: 'error', code: 'inspect/load-failed', message: `${row.moduleName}（${row.entryId}）載入失敗：${row.diagnostic ?? '沒有診斷訊息'}` })
		}
	}

	const all = [...findings, ...bundles.flatMap((bundle) => bundle.findings)]
	const counts = { error: 0, warn: 0, info: 0 }
	for (const finding of all) counts[finding.level] += 1
	return { ...base, ok: counts.error === 0, counts, bundles, findings }
}

/**
 * @param {object[]} findings
 * @param {string} indent
 * @returns {string[]}
 */
function renderFindings(findings, indent) {
	return findings.flatMap((finding) => [
		`${indent}${MARK[finding.level]} [${finding.code}] ${finding.message}`,
		...(finding.hint === undefined ? [] : [`${indent}  → ${finding.hint}`]),
	])
}

/**
 * @param {object} result output of `inspectProfile()`
 * @returns {string}
 */
export function renderInspectReport(result) {
	const { counts } = result
	const lines = [
		`plugin_inspect ${result.root}`,
		`host: ${result.hostVersion ?? '（未提供，略過相容性判定）'}`,
		`live: ${result.liveChecked ? '已讀 loader 狀態' : '無（不在執行中的 Host 內，state 為 unknown，只做靜態檢查）'}`,
		'',
		`${result.ok ? '通過' : '未通過'}：${counts.error} error · ${counts.warn} warn · ${counts.info} info`,
	]
	const officialCount = result.bundles.filter((bundle) => bundle.state === 'official').length
	const shown = result.bundles.filter((bundle) => bundle.state !== 'official')
	if (result.findings.length > 0) lines.push('', ...renderFindings(result.findings, ''))
	if (shown.length > 0) lines.push('')
	for (const bundle of shown) {
		const version = bundle.version === undefined ? '' : `@${bundle.version}`
		lines.push(`${bundle.name}${version}  ${bundle.state}  ${bundle.source}`, ...renderFindings(bundle.findings, '  '))
	}
	if (officialCount > 0) lines.push('', `另有 ${officialCount} 個隨 DSH 內建的 bundle，未逐一列出。`)
	return lines.join('\n')
}

/**
 * @param {object} result output of `inspectProfile()`
 * @returns {string}
 */
export function inspectSummaryLine(result) {
	const { error, warn, info } = result.counts
	return `${result.ok ? 'OK' : 'FAIL'} ${error} error ${warn} warn ${info} info`
}
