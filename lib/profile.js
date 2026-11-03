/**
 * What the profile already has, and whether a candidate would collide with it.
 *
 * The reader is read-only by construction: it opens `package.json` files and
 * computes, never writes. A profile's declared specs are ranges (`^0.2.0`), so
 * the concrete version that is actually installed is read from
 * `node_modules/<name>/package.json`; `link:` / `file:` entries instead point at
 * a real directory, and their version comes from that directory's manifest.
 *
 * Every failure here is a value, not an exception: a missing or unreadable
 * profile is `installed: false` and the audit turns that into
 * `audit/profile-absent` rather than aborting the whole report.
 *
 * @module dsh-plugin-devkit/profile
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { compareVersions, parseRange, parseVersion, satisfies } from './semver.js'

/** The package a DSH profile records the Host version under. */
const HOST_PACKAGE = '@deepseek-ai/dsh-tools'
/** Prefix -> kind, in the order the contract lists them. */
const KIND_PREFIXES = [
	['link:', 'link'],
	['file:', 'file'],
	['github:', 'github'],
	['workspace:', 'workspace'],
]
/** Kinds whose version comes from the directory they point at. */
const LOCAL_KINDS = new Set(['link', 'file'])
/** Kinds a registry install would replace, which is worth saying out loud. */
const REPLACED_BY_REGISTRY = new Set(['link', 'file', 'github'])

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | undefined>}
 */
async function statIfAny(path) {
	try {
		return await stat(path)
	} catch {
		return undefined
	}
}

/**
 * Parse a JSON file, tolerating every way it can be absent.
 *
 * @param {string} path
 * @returns {Promise<Record<string, any> | undefined>} undefined when the file is
 *   missing, not a file, not JSON, or not a JSON object
 */
async function readJsonObject(path) {
	try {
		const info = await stat(path)
		if (!info.isFile()) return undefined
		const parsed = JSON.parse(await readFile(path, 'utf8'))
		return isPlainObject(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * Find the manifest of `dir` itself, or of its single child directory.
 *
 * The second form exists because callers pass either the profile directory
 * (`…/profiles/desktop`) or the directory holding profiles (`…/profiles`). Two
 * candidate children are ambiguous, so that is reported as absent rather than
 * guessed at.
 *
 * @param {string} dir
 * @returns {Promise<{ manifestPath: string, manifest: Record<string, any> } | undefined>}
 */
async function locateManifest(dir) {
	const directPath = join(dir, 'package.json')
	const direct = await readJsonObject(directPath)
	if (direct !== undefined) return { manifestPath: directPath, manifest: direct }

	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return undefined
	}
	const candidates = []
	for (const entry of entries.filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
		const manifestPath = join(dir, entry, 'package.json')
		const manifest = await readJsonObject(manifestPath)
		if (manifest !== undefined) candidates.push({ manifestPath, manifest })
	}
	return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * Which install source a declared spec means.
 *
 * @param {string} raw
 * @returns {'range' | 'link' | 'file' | 'github' | 'workspace'}
 */
function kindOf(raw) {
	const text = raw.trim().toLowerCase()
	for (const [prefix, kind] of KIND_PREFIXES) {
		if (text.startsWith(prefix)) return /** @type {any} */ (kind)
	}
	return 'range'
}

/**
 * Resolve the directory a `link:` / `file:` spec points at.
 *
 * @param {string} root profile directory
 * @param {string} raw the declared spec, prefix included
 * @returns {string} absolute path
 */
function localTarget(root, raw) {
	const text = raw.trim()
	const body = text.slice(text.indexOf(':') + 1).replace(/\\/g, '/')
	return isAbsolute(body) ? resolve(body) : resolve(root, body)
}

/**
 * The concrete version of a range dependency: what is on disk under
 * `node_modules`, or an exact version when the spec itself pins one.
 *
 * @param {string} root profile directory
 * @param {string} name dependency name
 * @param {string} raw the declared spec
 * @returns {Promise<string | undefined>}
 */
async function installedVersionOf(root, name, raw) {
	const manifest = await readJsonObject(join(root, 'node_modules', name, 'package.json'))
	if (typeof manifest?.version === 'string') return manifest.version
	return parseVersion(raw) === undefined ? undefined : raw
}

/**
 * Read a profile directory.
 *
 * @param {string} dir profile root, a directory holding `package.json`, or one
 *   holding a single profile directory
 * @returns {Promise<{
 *   root: string,
 *   installed: boolean,
 *   manifest?: Record<string, any>,
 *   dependencies: Record<string, { raw: string, kind: string, version?: string, resolvedPath?: string }>,
 *   bundles: string[],
 *   hostVersion?: string,
 * }>}
 */
export async function readProfile(dir) {
	const target = resolve(String(dir ?? '.'))
	const info = await statIfAny(target)
	const located = info?.isFile()
		? { manifestPath: target, manifest: await readJsonObject(target) }
		: await locateManifest(target)

	if (located === undefined || located.manifest === undefined) {
		return { root: target, installed: false, manifest: undefined, dependencies: {}, bundles: [] }
	}

	const root = dirname(located.manifestPath)
	const manifest = located.manifest
	const dependencies = {}
	const declared = isPlainObject(manifest.dependencies) ? manifest.dependencies : {}
	for (const [name, raw] of Object.entries(declared)) {
		const spec = typeof raw === 'string' ? raw : String(raw)
		const kind = kindOf(spec)
		/** @type {{ raw: string, kind: string, version?: string, resolvedPath?: string }} */
		const entry = { raw: spec, kind }
		if (LOCAL_KINDS.has(kind)) {
			const resolvedPath = localTarget(root, spec)
			entry.resolvedPath = resolvedPath
			const localManifest = await readJsonObject(join(resolvedPath, 'package.json'))
			if (typeof localManifest?.version === 'string') entry.version = localManifest.version
		} else {
			const version = await installedVersionOf(root, name, spec)
			if (version !== undefined) entry.version = version
		}
		dependencies[name] = entry
	}

	const profileSection = isPlainObject(manifest.dsh) && isPlainObject(manifest.dsh.profile) ? manifest.dsh.profile : {}
	const bundles = Array.isArray(profileSection.bundles)
		? profileSection.bundles.filter((value) => typeof value === 'string')
		: []

	const devDependencies = isPlainObject(manifest.devDependencies) ? manifest.devDependencies : {}
	const hostSpec = typeof declared[HOST_PACKAGE] === 'string'
		? declared[HOST_PACKAGE]
		: typeof devDependencies[HOST_PACKAGE] === 'string'
			? devDependencies[HOST_PACKAGE]
			: undefined

	return {
		root,
		installed: true,
		manifest,
		dependencies,
		bundles,
		...(hostSpec === undefined ? {} : { hostVersion: hostSpec }),
	}
}

/**
 * Would installing this candidate fight with what the profile already has?
 *
 * Three answers, in the contract's order: an unmet range is an error, the same
 * package at another version is an upgrade note, and no overlap at all is a note
 * that this is a fresh install.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.candidate] the candidate's manifest
 * @param {object} [input.profile] output of `readProfile()`
 * @param {string} [input.candidateName] package name; falls back to `candidate.name`
 * @param {string} [input.candidateVersion] version being installed
 * @returns {Array<{ level: 'error' | 'warn' | 'info', code: string, message: string, hint?: string, evidence?: object }>}
 */
export function collisionFindings({ candidate, profile, candidateName, candidateVersion } = {}) {
	const name = typeof candidateName === 'string' && candidateName !== '' ? candidateName : candidate?.name

	if (!isPlainObject(profile) || profile.installed === false) {
		const where = isPlainObject(profile) && typeof profile.root === 'string' ? `（${profile.root}）` : ''
		return [
			{
				level: 'info',
				code: 'audit/profile-absent',
				message: `找不到可讀的 profile${where}：沒有已安裝的套件可能撞車，這次等於全新安裝。`,
			},
		]
	}

	const manifest = isPlainObject(candidate) ? candidate : {}
	const installed = isPlainObject(profile.dependencies) ? profile.dependencies : {}
	/** @type {Array<{ level: 'error' | 'warn' | 'info', code: string, message: string, hint?: string, evidence?: object }>} */
	const findings = []
	const seen = new Set()

	let overlap = false
	for (const field of ['dependencies', 'peerDependencies']) {
		const section = isPlainObject(manifest[field]) ? manifest[field] : {}
		for (const [dependency, range] of Object.entries(section)) {
			if (typeof range !== 'string') continue
			if (!Object.hasOwn(installed, dependency)) continue
			overlap = true
			const entry = installed[dependency]
			if (!isPlainObject(entry) || entry.kind !== 'range' || typeof entry.version !== 'string') {
				// A link:/file:/github: installation has no registry range to compare,
				// so say it is there instead of letting the overlap pass in silence.
				const key = `${dependency}\u0000source\u0000${field}`
				if (seen.has(key)) continue
				seen.add(key)
				const raw = isPlainObject(entry) && typeof entry.raw === 'string' ? entry.raw : '未知來源'
				const kind = isPlainObject(entry) && typeof entry.kind === 'string' ? entry.kind : '未知'
				findings.push({
					level: 'warn',
					code: 'audit/profile-source',
					message: `profile 內的 ${dependency} 來自 ${raw}（${kind}），不是 registry 範圍：無法用版本範圍判定是否撞車。`,
					hint: `這是既有安裝（候選要求 ${range}）；先確認兩者行為相容，或把它換成 registry 版本再裝。`,
					evidence: { name: dependency, raw, kind, required: range, field },
				})
				continue
			}
			if (!parseRange(range).valid) {
				const key = `${dependency}\u0000unparsable\u0000${field}`
				if (seen.has(key)) continue
				seen.add(key)
				findings.push({
					level: 'info',
					code: 'audit/profile-unparsable',
					message: `候選對 ${dependency} 要求的範圍 ${JSON.stringify(range)} 無法解析：略過這條撞車判定。`,
					hint: '範圍寫法不標準，無法比較；改以人工確認版本。',
					evidence: { name: dependency, required: range, installedVersion: entry.version, field },
				})
				continue
			}
			if (satisfies(entry.version, range)) continue

			const key = `${dependency}\u0000${range}\u0000${field}`
			if (seen.has(key)) continue
			seen.add(key)
			findings.push({
				level: 'error',
				code: 'audit/profile-collision',
				message: `profile 已安裝 ${dependency}@${entry.version}，但候選要求 ${range}：兩者不相容，安裝後會版本衝突。`,
				hint: `先把 profile 內的 ${dependency} 升到符合 ${range} 的版本，或請作者放寬範圍；兩邊都不動就別裝。`,
				evidence: { name: dependency, installedVersion: entry.version, required: range, field },
			})
		}
	}

	const current = typeof name === 'string' ? installed[name] : undefined
	if (isPlainObject(current)) {
		overlap = true
		const alreadyInstalled = typeof current.version === 'string' ? current.version : undefined
		const same =
			typeof candidateVersion === 'string' &&
			alreadyInstalled !== undefined &&
			compareVersions(candidateVersion, alreadyInstalled) === 0
		if (!same) {
			const from = alreadyInstalled === undefined ? `來源 ${current.raw}` : `${alreadyInstalled}（${current.raw}）`
			const to = typeof candidateVersion === 'string' ? candidateVersion : '候選版本'
			const parts = [`profile 已有 ${name}，目前是 ${from}；這次安裝會變成 ${to}。`]
			if (REPLACED_BY_REGISTRY.has(current.kind)) {
				parts.push(`${current.raw} 指向本機或 git，安裝後來源會被換成 registry。`)
			}
			findings.push({
				level: 'info',
				code: 'audit/profile-upgrade',
				message: parts.join(' '),
				hint:
					current.kind === 'range'
						? '版本不同不阻斷安裝，但裝完請確認 profile 內其他外掛還相容。'
						: '要保留原本的本機／git 來源就不要安裝；改用 registry 版本前先確認行為一致。',
				evidence: { name, installedVersion: alreadyInstalled, nextVersion: candidateVersion, raw: current.raw, kind: current.kind },
			})
		}
	}

	if (!overlap) {
		findings.push({
			level: 'info',
			code: 'audit/profile-absent',
			message: `profile 內沒有 ${typeof name === 'string' ? name : '這個套件'}，也沒有與它重疊的依賴：這次是新增，不會覆蓋既有版本。`,
		})
	}

	return findings
}
