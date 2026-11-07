import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { configFindings, diagnose } from '../lib/checks.js'
import { inspectProfile, readLiveEntries, renderInspectReport } from '../lib/inspect.js'
import { scaffoldFiles } from '../lib/scaffold.js'
import { createInspectTool } from '../lib/tools.js'

const PATCH = '- insert:\n    - id: good\n      name: dsh-good\n'

/**
 * @param {string} root
 * @param {string} name
 * @param {Record<string, any>} [overrides]
 * @param {string} [entry]
 */
function installBundle(root, name, overrides = {}, entry = 'export const name = "x"\nexport function apply() {}\n') {
	const dir = join(root, 'node_modules', name)
	mkdirSync(join(dir, 'lib'), { recursive: true })
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: './lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...overrides }))
	writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
	writeFileSync(join(dir, 'lib', 'index.js'), entry)
}

/**
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} dependencies
 * @param {string[]} bundles
 * @returns {string}
 */
function makeProfile(t, dependencies, bundles) {
	const root = mkdtempSync(join(tmpdir(), 'devkit-inspect-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies, dsh: { profile: { bundles } } }))
	return root
}

const row = (entryId, moduleName, phase, extra = {}) => ({ entryId, moduleName, enabled: true, phase, ...extra })
const codes = (bundle) => bundle.findings.map((finding) => finding.code)

test('Config：repo-ops 0.1.1 的普通物件寫法是 error', () => {
	const findings = configFindings("export const Config = { timeoutMs: { type: 'number', default: 5000 } }")
	assert.deepEqual(findings.map((finding) => [finding.level, finding.code]), [['error', 'entry/config-shape']])
})

test('Config：只在註解提到 ~standard 不算數', () => {
	const source = "// cordis reads Config['~standard'].validate\nexport const Config = { timeoutMs: {} }"
	assert.equal(configFindings(source)[0].code, 'entry/config-shape')
})

test('Config：standard-schema 字面物件通過，沒匯出也通過', () => {
	assert.deepEqual(configFindings("export const Config = { '~standard': { version: 1, vendor: 'x', validate: (value) => ({ value }) } }"), [])
	assert.deepEqual(configFindings('export function apply() {}'), [])
})

test('Config：非同步 validate 是 error', () => {
	const source = "export const Config = { '~standard': { version: 1, vendor: 'x', async validate() { return { value: {} } } } }"
	assert.equal(configFindings(source)[0].code, 'entry/config-async')
})

test('Config：非字面值（如 zod）靜態驗不了，只給 info', () => {
	assert.deepEqual(configFindings('export const Config = z.object({})').map((finding) => finding.level), ['info'])
	assert.deepEqual(configFindings("export { Config } from './config.js'").map((finding) => finding.level), ['info'])
})

test('doctor 擋下壞 Config；給了 config 但沒匯出 Config 不再回報', () => {
	const files = Object.fromEntries(scaffoldFiles({ name: 'dsh-foo-bar', author: 'T', year: 2026 }).map((file) => [file.path, file.content]))
	const broken = { ...files, 'lib/index.js': `${files['lib/index.js']}\nexport const Config = { a: { type: 'string' } }\n` }
	const result = diagnose({ files: broken })
	assert.equal(result.ok, false)
	assert.ok(result.findings.some((finding) => finding.code === 'entry/config-shape'))

	const configured = { ...files, 'cordis.patch.yml': files['cordis.patch.yml'].replace(/config: \{\}/, 'config:\n        a: 1') }
	assert.equal(diagnose({ files: configured }).findings.length, 0)
})

test('doctor：engines.dsh 上限沒寫 -0 回 warn，寫了就不回', () => {
	const files = Object.fromEntries(scaffoldFiles({ name: 'dsh-foo-bar', author: 'T', year: 2026 }).map((file) => [file.path, file.content]))
	const withEngines = (range) => {
		const manifest = JSON.parse(files['package.json'])
		manifest.engines.dsh = range
		return diagnose({ files: { ...files, 'package.json': JSON.stringify(manifest) } }).findings.map((finding) => finding.code)
	}
	assert.ok(withEngines('>=0.2.0 <0.3.0').includes('compat/engines-prerelease-cap'))
	assert.ok(!withEngines('>=0.2.0 <0.3.0-0').includes('compat/engines-prerelease-cap'))
	assert.ok(!withEngines('>=0.2.0 <=0.3.0').includes('compat/engines-prerelease-cap'))
})

test('readLiveEntries：照 Cordis 的 fiber 狀態投影，failed 帶診斷，group 略過', async () => {
	const loader = {
		*entries() {
			yield { id: 'group', options: { group: true, name: 'g' } }
			yield { id: 'a', options: { name: 'dsh-a' }, disabled: false, fiber: { state: 2 } }
			yield { id: 'b', options: { name: 'dsh-b' }, disabled: false, fiber: { state: 3, await: async () => { throw new Error('boom') } } }
			yield { id: 'c', options: { name: 'dsh-c' }, disabled: true }
		},
	}
	assert.deepEqual(await readLiveEntries(loader), [
		row('a', 'dsh-a', 'active'),
		row('b', 'dsh-b', 'failed', { diagnostic: 'boom' }),
		{ entryId: 'c', moduleName: 'dsh-c', enabled: false, phase: null },
	])
	assert.equal(await readLiveEntries(undefined), undefined)
})

test('inspect：active 乾淨通過', async (t) => {
	const root = makeProfile(t, { 'dsh-good': '1.0.0' }, ['dsh-good', '@deepseek-ai/dsh-base'])
	installBundle(root, 'dsh-good')
	const result = await inspectProfile({ profileDir: root, live: [row('good', 'dsh-good', 'active')] })
	assert.equal(result.ok, true)
	assert.equal(result.bundles.find((bundle) => bundle.name === 'dsh-good').state, 'active')
	assert.equal(result.bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-base').state, 'official')
})

test('inspect：load 失敗是 error，帶診斷；安裝成功不等於載入成功', async (t) => {
	const root = makeProfile(t, { 'dsh-good': '1.0.0' }, ['dsh-good'])
	installBundle(root, 'dsh-good')
	const result = await inspectProfile({ profileDir: root, live: [row('good', 'dsh-good', 'failed', { diagnostic: 'Cannot read properties of undefined' })] })
	assert.equal(result.ok, false)
	assert.deepEqual(codes(result.bundles[0]), ['inspect/load-failed'])
	assert.match(renderInspectReport(result), /Cannot read properties of undefined/)
})

test('inspect：靠 patch 的 insert id 也對得上 entry', async (t) => {
	const root = makeProfile(t, { 'dsh-good': '1.0.0' }, ['dsh-good'])
	installBundle(root, 'dsh-good')
	const result = await inspectProfile({ profileDir: root, live: [row('good', './index.js', 'active')] })
	assert.equal(result.bundles[0].state, 'active')
})

test('inspect：在清單裡卻沒有 entry 是 not-loaded；停用是 disabled', async (t) => {
	const root = makeProfile(t, { 'dsh-good': '1.0.0' }, ['dsh-good'])
	installBundle(root, 'dsh-good')
	assert.equal((await inspectProfile({ profileDir: root, live: [] })).bundles[0].state, 'not-loaded')
	const disabled = await inspectProfile({ profileDir: root, live: [{ ...row('good', 'dsh-good', null), enabled: false }] })
	assert.equal(disabled.bundles[0].state, 'disabled')
	assert.equal(disabled.ok, true)
})

test('inspect：沒有 live 時 state 為 unknown，但靜態問題照報', async (t) => {
	const root = makeProfile(t, { 'dsh-bad': '1.0.0' }, ['dsh-bad'])
	installBundle(root, 'dsh-bad', {}, "export const Config = { a: { type: 'string' } }\n")
	const result = await inspectProfile({ profileDir: root })
	assert.equal(result.bundles[0].state, 'unknown')
	assert.deepEqual(codes(result.bundles[0]), ['entry/config-shape'])
	assert.equal(result.ok, false)
	assert.match(renderInspectReport(result), /只做靜態檢查/)
})

test('inspect：link 目標不見、裝了沒選、版本閘門', async (t) => {
	const root = makeProfile(t, { 'dsh-gone': 'link:./missing', 'dsh-idle': '1.0.0', 'dsh-old': '1.0.0' }, ['dsh-gone', 'dsh-old'])
	installBundle(root, 'dsh-idle')
	installBundle(root, 'dsh-old', { engines: { dsh: '<0.1.0-0' } })
	const { bundles } = await inspectProfile({ profileDir: root, hostVersion: '0.2.2-rc.1', live: [] })
	const byName = Object.fromEntries(bundles.map((bundle) => [bundle.name, bundle]))
	assert.deepEqual(codes(byName['dsh-gone']), ['inspect/link-missing'])
	assert.equal(byName['dsh-idle'].state, 'not-selected')
	assert.ok(codes(byName['dsh-old']).includes('inspect/compat-unmet'))
})

test('inspect：不屬於任何 bundle 的 failed entry 也要報，指定單一 bundle 時才略過', async (t) => {
	const root = makeProfile(t, {}, [])
	const live = [row('official', '@deepseek-ai/dsh-x', 'failed', { diagnostic: 'nope' })]
	const result = await inspectProfile({ profileDir: root, live })
	assert.equal(result.ok, false)
	assert.equal(result.findings[0].code, 'inspect/load-failed')
})

test('inspect：讀不到 profile、查不到 bundle 都回值，不丟例外', async (t) => {
	const root = makeProfile(t, {}, [])
	assert.equal((await inspectProfile({ profileDir: join(root, 'nope') })).findings[0].code, 'inspect/profile-unreadable')
	assert.equal((await inspectProfile({ profileDir: root, name: 'dsh-x' })).findings[0].code, 'inspect/unknown-bundle')
})

test('plugin_inspect 工具：從 getLoader 取 live，壞的 loader 不會讓工具崩潰', async (t) => {
	const root = makeProfile(t, { 'dsh-good': '1.0.0' }, ['dsh-good'])
	installBundle(root, 'dsh-good')
	const loader = { *entries() { yield { id: 'good', options: { name: 'dsh-good' }, disabled: false, fiber: { state: 2 } } } }
	const live = await createInspectTool({ getLoader: () => loader }).execute({ profileDir: root })
	assert.match(live, /dsh-good@1\.0\.0 {2}active/)

	const broken = await createInspectTool({ getLoader: () => { throw new Error('no service') } }).execute({ profileDir: root })
	assert.match(broken, /unknown/)

	const json = JSON.parse(await createInspectTool().execute({ profileDir: root, format: 'json' }))
	assert.equal(json.liveChecked, false)
})
