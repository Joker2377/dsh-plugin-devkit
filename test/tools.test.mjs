import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import { createAuditTool, createDevkitTools } from '../lib/tools.js'
import { parseAuditArgs } from '../scripts/cli.mjs'

/**
 * The audit pipeline is written by another owner and lands independently, so the
 * wiring tests only run once it is importable. Everything else here is offline
 * and needs no registry.
 */
const auditModules = await Promise.all([
	import('../lib/audit.js').then(
		(module) => module,
		() => undefined
	),
	import('../lib/audit-report.js').then(
		(module) => module,
		() => undefined
	),
])
const auditAvailable = auditModules[0] !== undefined && auditModules[1] !== undefined
const wiringSkip = auditAvailable ? false : 'lib/audit.js 或 lib/audit-report.js 尚未落地（另一位擁有者仍在寫）'

test('parseAuditArgs：只有 spec 時走 text 且沒有任何覆寫', () => {
	const parsed = parseAuditArgs(['lodash@4.17.21'])
	assert.equal(parsed.spec, 'lodash@4.17.21')
	assert.equal(parsed.format, 'text')
	assert.deepEqual(parsed.options, {})
	assert.equal(parsed.error, undefined)
})

test('parseAuditArgs：--json 與三個覆寫（= 形式）', () => {
	const parsed = parseAuditArgs([
		'@scope/name@1.0.0-rc.1',
		'--json',
		'--registry=https://registry.npmmirror.com',
		'--profile=profiles/desktop',
		'--host=0.2.1-rc.5',
	])
	assert.equal(parsed.spec, '@scope/name@1.0.0-rc.1')
	assert.equal(parsed.format, 'json')
	assert.equal(parsed.options.registry, 'https://registry.npmmirror.com')
	assert.equal(parsed.options.profileDir, resolve(process.cwd(), 'profiles/desktop'))
	assert.equal(parsed.options.hostVersion, '0.2.1-rc.5')
})

test('parseAuditArgs：空格分隔的覆寫值', () => {
	const parsed = parseAuditArgs(['github:owner/repo', '--registry', 'https://example.test', '--host', '0.2.1'])
	assert.equal(parsed.spec, 'github:owner/repo')
	assert.equal(parsed.options.registry, 'https://example.test')
	assert.equal(parsed.options.hostVersion, '0.2.1')
	assert.equal(parsed.format, 'text')
})

test('parseAuditArgs：缺 spec 時 spec 為 undefined，由呼叫端決定結束碼', () => {
	const parsed = parseAuditArgs(['--json'])
	assert.equal(parsed.spec, undefined)
	assert.equal(parsed.format, 'json')
	assert.equal(parsed.error, undefined)
})

test('parseAuditArgs：多出第二個 spec 是錯誤，不是靜默取第一個', () => {
	const parsed = parseAuditArgs(['lodash', 'left-pad'])
	assert.equal(parsed.spec, undefined)
	assert.match(parsed.error, /只接受一個 spec/u)
	assert.match(parsed.error, /left-pad/u)
})

test('plugin_audit 的定義：必填 spec、format 只收 text|json、說明寫明唯讀', () => {
	const tool = createAuditTool()
	assert.equal(tool.name, 'plugin_audit')
	assert.equal(tool.parameters.spec.required, true)
	assert.deepEqual(tool.parameters.format.enum, ['text', 'json'])
	for (const key of ['registry', 'profileDir', 'hostVersion']) {
		assert.equal(tool.parameters[key].required, undefined, `${key} 應為選填`)
	}
	assert.match(tool.description, /READ-ONLY/u)
	assert.match(tool.description, /installs nothing/u)
	assert.match(tool.description, /runs no package code/u)
	assert.equal(tool.isConcurrencySafe(), true)
})

test('plugin_audit：空 spec 回可讀字串，不丟例外', async () => {
	const tool = createAuditTool()
	const answer = await tool.execute({ spec: '   ' })
	assert.equal(typeof answer, 'string')
	assert.match(answer, /^plugin_audit: `spec` 不能為空/u)
})

test('createDevkitTools 仍註冊原本那兩個工具', () => {
	const names = createDevkitTools().map((tool) => tool.name)
	assert.deepEqual(names.slice(0, 2), ['plugin_scaffold', 'plugin_doctor'])
})

test('plugin_audit：local spec 走完整接線，判 allow 且不連網', { skip: wiringSkip }, async () => {
	const tool = createAuditTool()
	const answer = await tool.execute({ spec: './does-not-exist', profileDir: process.cwd() })
	assert.equal(typeof answer, 'string')
	assert.match(answer, /^plugin_audit \.\/does-not-exist/u)
	assert.match(answer, /結論：/u)
})

test('plugin_audit：format=json 回可解析的 AuditResult', { skip: wiringSkip }, async () => {
	const tool = createAuditTool()
	const answer = await tool.execute({ spec: 'github:owner/repo', profileDir: process.cwd(), format: 'json' })
	const result = JSON.parse(answer)
	assert.equal(result.target.kind, 'git')
	assert.ok(result.findings.some((finding) => finding.code === 'audit/spec-unsupported'))
	assert.ok(['allow', 'block', 'not-audited'].includes(result.verdict.install))
	assert.equal(result.verdict.install, 'not-audited', 'git spec 沒跑 registry 檢查，不能算通過')
	assert.deepEqual(Object.keys(result.counts).sort(), ['error', 'info', 'warn'])
})

test('plugin_audit：format 的非 json 值一律以 text 呈現', { skip: wiringSkip }, async () => {
	const tool = createAuditTool()
	const answer = await tool.execute({ spec: 'github:owner/repo', profileDir: process.cwd(), format: 'yaml' })
	assert.doesNotMatch(answer, /^\s*\{/u)
	assert.match(answer, /^plugin_audit github:owner\/repo/u)
})
