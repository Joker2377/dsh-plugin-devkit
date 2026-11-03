import assert from 'node:assert/strict'
import test from 'node:test'

import { diagnose, evaluateRequirements } from '../lib/checks.js'
import { scaffoldFiles } from '../lib/scaffold.js'

/**
 * Turn generated files into the snapshot `diagnose()` takes.
 *
 * @param {object} [options] passed through to `scaffoldFiles`
 * @returns {Record<string, string>}
 */
function snapshot(options = {}) {
	const files = scaffoldFiles({ name: 'dsh-foo-bar', author: 'Tester', year: 2026, ...options })
	return Object.fromEntries(files.map((file) => [file.path, file.content]))
}

/**
 * @param {Record<string, string>} files
 * @param {string} code
 * @returns {boolean}
 */
function has(files, code, hostVersion) {
	return diagnose({ files, hostVersion }).findings.some((finding) => finding.code === code)
}

test('骨架本身零 error 零 warn', () => {
	const result = diagnose({ files: snapshot() })
	assert.deepEqual(result.counts, { error: 0, warn: 0, info: 0 })
	assert.equal(result.ok, true)
})

test('沒有 package.json 就是 error', () => {
	const result = diagnose({ files: {} })
	assert.equal(result.ok, false)
	assert.equal(result.findings[0].code, 'manifest/missing')
})

test('manifest 的壞欄位各自被指出', () => {
	const broken = snapshot()
	broken['package.json'] = JSON.stringify({
		name: 'dsh-foo-bar',
		version: 'v1',
		type: 'commonjs',
		main: './lib/nope.js',
		dsh: { bundle: {} }
	})
	const codes = diagnose({ files: broken }).findings.map((finding) => finding.code)
	for (const expected of ['manifest/version', 'manifest/type', 'manifest/main-missing', 'bundle/patch-undeclared']) {
		assert.ok(codes.includes(expected), `缺 ${expected}`)
	}
})

test('patch 的 name 與套件名不一致時警告', () => {
	const broken = snapshot()
	broken['cordis.patch.yml'] = ['- insert:', '    - id: foo-bar', '      name: dsh-other', '      config: {}', ''].join('\n')
	assert.equal(has(broken, 'patch/name-mismatch'), true)
})

test('沒有 insert 的 patch 是 error', () => {
	const broken = snapshot()
	broken['cordis.patch.yml'] = '# 空的\n'
	assert.equal(has(broken, 'patch/insert-missing'), true)
})

test('入口少了 name 或 apply 都是 error', () => {
	const broken = snapshot()
	broken['lib/index.js'] = 'export const other = 1\n'
	const codes = diagnose({ files: broken }).findings.map((finding) => finding.code)
	assert.ok(codes.includes('entry/name-missing'))
	assert.ok(codes.includes('entry/apply-missing'))
})

test('README 缺安裝段是警告，缺 README 是 error', () => {
	const noSection = snapshot()
	noSection['README.md'] = '# dsh-foo-bar\n\n只有一句話。\n'
	assert.equal(has(noSection, 'docs/install-section'), true)

	const noReadme = snapshot()
	delete noReadme['README.md']
	assert.equal(has(noReadme, 'docs/readme-missing'), true)
})

test('完全沒有相容性宣告時提醒一次', () => {
	const undeclared = snapshot()
	const manifest = JSON.parse(undeclared['package.json'])
	delete manifest.engines.dsh
	delete manifest.peerDependencies
	undeclared['package.json'] = JSON.stringify(manifest)
	assert.equal(has(undeclared, 'compat/undeclared'), true)
})

test('engines.dsh 決定一切，peer 只在它缺席時才看', () => {
	assert.deepEqual(evaluateRequirements({ engines: { dsh: '>=0.2.0 <0.3.0' } }, '0.2.1-rc.5'), [])
	assert.deepEqual(
		evaluateRequirements({ engines: { dsh: '>=0.2.0 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-tools': '<0.0.1' } }, '0.2.1-rc.5'),
		[]
	)
	assert.deepEqual(
		evaluateRequirements({ peerDependencies: { '@deepseek-ai/dsh-tools': '<0.0.1' } }, '0.2.1-rc.5'),
		[{ field: 'peerDependencies.@deepseek-ai/dsh-tools', range: '<0.0.1' }]
	)
	// 非 DSH 的 peer 不參與判定。
	assert.deepEqual(evaluateRequirements({ peerDependencies: { lodash: '<0.0.1' } }, '0.2.1-rc.5'), [])
})

test('給 hostVersion 時，超出範圍會警告而不是 error', () => {
	const result = diagnose({ files: snapshot(), hostVersion: '0.1.0' })
	const unmet = result.findings.filter((finding) => finding.code === 'compat/unmet')
	assert.equal(unmet.length, 1)
	assert.equal(unmet[0].level, 'warn')
	assert.match(unmet[0].message, /incompatible-version/)

	assert.equal(diagnose({ files: snapshot(), hostVersion: '0.2.1-rc.5' }).counts.warn, 0)
})

test('找不到測試檔與 CI 時只做提醒', () => {
	const bare = snapshot({ ci: false })
	delete bare['test/bundle.test.mjs']
	const codes = diagnose({ files: bare }).findings.map((finding) => finding.code)
	assert.ok(codes.includes('test/missing'))
	assert.ok(codes.includes('ci/missing'))
	assert.equal(has(bare, 'test/missing'), true)
})
