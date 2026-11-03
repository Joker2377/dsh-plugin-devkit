import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { gzipSync } from 'node:zlib'

import { auditSpec } from '../lib/audit.js'
import { auditSummaryLine, renderAuditReport } from '../lib/audit-report.js'

const HOST = '0.2.1'
const NOW = new Date('2026-11-03T04:00:00.000Z')
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-audit-'))
const EMPTY_PROFILE = join(TEMP_ROOT, 'empty-profile')
const COLLIDING_PROFILE = join(TEMP_ROOT, 'colliding-profile')

after(() => {
	rmSync(TEMP_ROOT, { recursive: true, force: true })
})

mkdirSync(EMPTY_PROFILE, { recursive: true })
writeFileSync(
	join(EMPTY_PROFILE, 'package.json'),
	JSON.stringify({ name: 'empty-profile', version: '1.0.0', dependencies: {} }, null, '\t'),
)

mkdirSync(join(COLLIDING_PROFILE, 'node_modules', 'left-pad'), { recursive: true })
writeFileSync(
	join(COLLIDING_PROFILE, 'package.json'),
	JSON.stringify(
		{
			name: 'desktop-profile',
			version: '1.0.0',
			dependencies: { '@deepseek-ai/dsh-tools': '0.1.0', 'left-pad': '1.0.0' },
			dsh: { profile: { bundles: [] } },
		},
		null,
		'\t',
	),
)
writeFileSync(
	join(COLLIDING_PROFILE, 'node_modules', 'left-pad', 'package.json'),
	JSON.stringify({ name: 'left-pad', version: '1.0.0' }, null, '\t'),
)

/**
 * One ustar header block with a valid octal checksum.
 *
 * @param {string} path entry path inside the archive
 * @param {number} size byte length of the body
 * @returns {Buffer}
 */
function tarHeader(path, size) {
	const header = Buffer.alloc(512, 0)
	header.write(path, 0, 100, 'utf8')
	header.write('0000644\0', 100, 'utf8')
	header.write('0000000\0', 108, 'utf8')
	header.write('0000000\0', 116, 'utf8')
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8')
	header.write('00000000000\0', 136, 'utf8')
	// The checksum is computed with its own field filled with spaces.
	header.write('        ', 148, 'utf8')
	header.write('0', 156, 'utf8')
	header.write('ustar\0', 257, 'utf8')
	header.write('00', 263, 'utf8')
	let sum = 0
	for (const byte of header) sum += byte
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
	return header
}

/**
 * @param {Record<string, string | Buffer>} files path -> body
 * @returns {Buffer} gzipped tarball
 */
function makeTarball(files) {
	const chunks = []
	for (const [path, content] of Object.entries(files)) {
		const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
		chunks.push(tarHeader(path, body.length), body)
		const padding = (512 - (body.length % 512)) % 512
		if (padding > 0) chunks.push(Buffer.alloc(padding, 0))
	}
	chunks.push(Buffer.alloc(1024, 0))
	return gzipSync(Buffer.concat(chunks))
}

/**
 * @param {object} [overrides]
 * @returns {object} a clean plugin manifest
 */
function baseManifest(overrides = {}) {
	const manifest = {
		name: 'clean-plugin',
		version: '1.2.3',
		type: 'module',
		main: './lib/index.js',
		description: 'test fixture',
		repository: { type: 'git', url: 'git+https://github.com/example/clean-plugin.git' },
		dependencies: { 'left-pad': '^1.3.0' },
		engines: { dsh: '>=0.1.1-rc.2 <0.3.0' },
	}
	return Object.assign(manifest, overrides)
}

/**
 * Build a fake registry client around one tarball.
 *
 * @param {object} manifest manifest written into the tarball
 * @param {object} [options]
 * @returns {{ client: object, tarball: Buffer, manifest: object }}
 */
function buildPackage(manifest, options = {}) {
	const tarball = makeTarball({
		'package/package.json': JSON.stringify(manifest, null, '\t'),
		'package/lib/index.js': 'export const name = "clean-plugin"\n',
		...options.files,
	})
	const integrity = options.integrity ?? `sha512-${createHash('sha512').update(tarball).digest('base64')}`
	const shasum = options.shasum ?? createHash('sha1').update(tarball).digest('hex')
	const version = {
		name: manifest.name,
		version: manifest.version,
		manifest,
		dist: {
			tarball: `https://registry.example.test/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
			integrity,
			shasum,
		},
		gitHead: 'gitHead' in options ? options.gitHead : 'abcdef0123456789abcdef0123456789abcdef01',
		publishTime: 'publishTime' in options ? options.publishTime : '2026-10-01T00:00:00.000Z',
		deprecated: options.deprecated,
		requestedRange: 'latest',
	}
	const attestations = options.attestations ?? {
		found: true,
		status: 200,
		url: `https://registry.example.test/-/npm/v1/attestations/${manifest.name}@${manifest.version}`,
		predicates: ['https://slsa.dev/provenance/v1'],
		raw: {},
	}
	const client = {
		versionDoc: options.versionDoc ?? (async () => version),
		tarball: options.tarball ?? (async () => tarball),
		attestations: async () => attestations,
		packument: async () => ({}),
	}
	return { client, tarball, manifest }
}

/**
 * @param {object} [extra]
 * @returns {object} default `auditSpec` options
 */
function options(extra = {}) {
	return {
		registry: 'https://registry.example.test',
		profileDir: EMPTY_PROFILE,
		hostVersion: HOST,
		now: NOW,
		...extra,
	}
}

/**
 * @param {string} dir
 * @returns {string} sha256 over every file path and body below `dir`
 */
function digestTree(dir) {
	const hash = createHash('sha256')
	const walk = (current) => {
		const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
		for (const entry of entries) {
			const path = join(current, entry.name)
			if (entry.isDirectory()) {
				walk(path)
				continue
			}
			hash.update(path)
			hash.update(readFileSync(path))
		}
	}
	walk(dir)
	return hash.digest('hex')
}

/**
 * @param {object} result
 * @param {string} code
 * @returns {string | undefined}
 */
function messageFor(result, code) {
	return result.findings.find((finding) => finding.code === code)?.message
}

test('乾淨套件：八項檢查跑完並 allow', async () => {
	const { client } = buildPackage(baseManifest())
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))

	assert.equal(result.ok, true)
	assert.equal(result.verdict.install, 'allow')
	assert.deepEqual(result.verdict.blocking, [])
	assert.equal(result.counts.error, 0)
	assert.equal(result.counts.warn, 0)
	assert.equal(result.evidence.manifestSource, 'tarball')
	assert.equal(result.evidence.githeadVerified, false)
	assert.equal(result.evidence.commitUrl, 'https://github.com/example/clean-plugin/commit/abcdef0123456789abcdef0123456789abcdef01')
	assert.match(result.verdict.reason, /項檢查通過，無阻斷項/)

	const codes = result.findings.map((finding) => finding.code)
	for (const expected of [
		'audit/integrity-ok',
		'audit/dep-count',
		'audit/provenance-ok',
		'audit/githead-ok',
		'audit/compat-ok',
		'audit/profile-absent',
	]) {
		assert.ok(codes.includes(expected), `缺 ${expected}，實際：${codes.join(', ')}`)
	}
	assert.deepEqual(result.verdict.checked, [
		'integrity',
		'install-scripts',
		'dependency-surface',
		'provenance',
		'githead',
		'dsh-compat',
		'profile-collision',
		'tarball-contents',
	])
	assert.equal(result.target.kind, 'registry')
	assert.equal(result.target.version, '1.2.3')
	assert.equal(result.evidence.compat.hostVersion, HOST)
})

test('install 腳本：block，並把指令留在 evidence', async () => {
	const manifest = baseManifest({ scripts: { postinstall: 'node ./scripts/install.js' } })
	const { client } = buildPackage(manifest, { files: { 'package/scripts/install.js': 'console.log("no")\n' } })
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/install-script'])
	assert.equal(result.evidence.scripts.postinstall, 'node ./scripts/install.js')
	assert.match(result.verdict.reason, /postinstall/)
	assert.equal(result.findings.find((finding) => finding.code === 'audit/install-script').level, 'error')
})

test('integrity 不符：block 並列出雜湊', async () => {
	const broken = `sha512-${createHash('sha512').update('tampered bytes').digest('base64')}`
	const { client } = buildPackage(baseManifest(), { integrity: broken })
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/integrity-mismatch'])
	assert.match(messageFor(result, 'audit/integrity-mismatch'), /dist\.integrity/)
})

test('provenance 404：只 warn，不阻擋', async () => {
	const attestations = { found: false, status: 404, url: '', predicates: [], raw: undefined }
	const { client } = buildPackage(baseManifest(), { attestations })
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'allow')
	assert.deepEqual(result.verdict.blocking, [])
	assert.equal(result.evidence.provenance.status, 404)
	assert.equal(result.evidence.provenance.found, false)
	assert.ok(result.findings.some((finding) => finding.code === 'audit/provenance-missing' && finding.level === 'warn'))
})

test('缺 gitHead：warn，且不下結論說 commit 已核對', async () => {
	const manifest = baseManifest({ repository: undefined, gitHead: undefined })
	const { client } = buildPackage(manifest, { gitHead: undefined })
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'allow')
	assert.equal(result.evidence.gitHead, null)
	assert.equal(result.evidence.githeadVerified, false)
	assert.ok(result.findings.some((finding) => finding.code === 'audit/githead-missing' && finding.level === 'warn'))
	assert.equal(result.findings.some((finding) => finding.code === 'audit/githead-ok'), false)
})

test('engines.dsh 不滿足：block', async () => {
	const manifest = baseManifest({ engines: { dsh: '>=0.3.0' } })
	const { client } = buildPackage(manifest)
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/compat-unmet'])
	assert.match(messageFor(result, 'audit/compat-unmet'), /engines\.dsh >=0\.3\.0/)
	assert.equal(result.evidence.compat.unmet.length, 1)
})

test('peerDependency 不滿足：block', async () => {
	const manifest = baseManifest({
		engines: undefined,
		peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.3.0' },
	})
	const { client } = buildPackage(manifest)
	const result = await auditSpec('clean-plugin', options({ registryClient: client }))

	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/compat-unmet'])
	assert.match(messageFor(result, 'audit/compat-unmet'), /peerDependencies\.@deepseek-ai\/dsh-tools/)
})

test('profile 撞車：候選要求 ^2.0.0，profile 裝了 1.0.0 → block', async () => {
	const manifest = baseManifest({ dependencies: { 'left-pad': '^2.0.0' } })
	const { client } = buildPackage(manifest)
	const result = await auditSpec('clean-plugin', options({ registryClient: client, profileDir: COLLIDING_PROFILE }))

	assert.equal(result.verdict.install, 'block')
	assert.ok(result.verdict.blocking.includes('audit/profile-collision'))
	assert.equal(result.evidence.profile.installed, false)
	assert.deepEqual(result.evidence.profile.matched, ['left-pad'])
	assert.match(messageFor(result, 'audit/profile-collision'), /1\.0\.0/)
})

test('稽核不寫入 profile：呼叫前後檔案雜湊不變', async () => {
	const before = digestTree(COLLIDING_PROFILE)
	const manifest = baseManifest({ dependencies: { 'left-pad': '^2.0.0' } })
	const { client } = buildPackage(manifest)
	await auditSpec('clean-plugin', options({ registryClient: client, profileDir: COLLIDING_PROFILE }))
	assert.equal(digestTree(COLLIDING_PROFILE), before)
})

test('local spec：只給 spec-unsupported warn，完全不碰 registry，且不宣稱通過', async () => {
	let called = false
	const result = await auditSpec(
		'./some/local-plugin',
		options({
			registryClient: {
				versionDoc: async () => {
					called = true
					throw new Error('不該被呼叫')
				},
				tarball: async () => Buffer.alloc(0),
				attestations: async () => ({ found: false, status: 404 }),
				packument: async () => ({}),
			},
		}),
	)

	assert.equal(called, false)
	assert.equal(result.target.kind, 'local')
	assert.equal(result.verdict.install, 'not-audited')
	assert.equal(result.ok, false, '沒查過的東西不能回報成通過')
	assert.match(result.verdict.reason, /不是通過/u)
	assert.deepEqual(result.verdict.checked, [])
	assert.equal(result.findings.length, 1)
	assert.equal(result.findings[0].code, 'audit/spec-unsupported')
	assert.equal(result.findings[0].level, 'warn')
})

test('無法解析的 spec：立即 block，不進入網路段', async () => {
	const result = await auditSpec('', options())
	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/spec-invalid'])
	assert.equal(result.findings.length, 1)
	assert.equal(result.findings[0].level, 'error')
	assert.deepEqual(result.verdict.checked, [])
})

test('registry 404：轉成 version-missing block', async () => {
	const failure = Object.assign(new Error('registry 回應 404'), { code: 'NOT_FOUND', status: 404 })
	const result = await auditSpec(
		'missing-plugin',
		options({
			registryClient: {
				versionDoc: async () => {
					throw failure
				},
				tarball: async () => Buffer.alloc(0),
				attestations: async () => ({ found: false, status: 404 }),
				packument: async () => ({}),
			},
		}),
	)

	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/version-missing'])
	assert.equal(result.counts.error, 1)
})

test('text 報告：前三行固定、findings 依嚴重度排序、最後一行給建議', async () => {
	const manifest = baseManifest({ scripts: { install: 'node ./scripts/install.js' } })
	const { client } = buildPackage(manifest, {
		attestations: { found: false, status: 404, url: '', predicates: [], raw: undefined },
	})
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	const lines = renderAuditReport(result).split('\n')

	assert.equal(lines[0], 'plugin_audit clean-plugin@1.2.3')
	assert.ok(lines[1].startsWith('結論：不可以安裝 — '))
	assert.ok(lines[2].includes(`${result.counts.error} error`))
	assert.ok(lines[2].includes('已檢查：integrity'))

	const errorIndex = lines.findIndex((line) => line.startsWith('✗'))
	const warnIndex = lines.findIndex((line) => line.startsWith('⚠'))
	const infoIndex = lines.findIndex((line) => line.startsWith('·'))
	assert.ok(errorIndex > 0, '沒有 error 段')
	assert.ok(warnIndex > errorIndex, `warn 沒有排在 error 之後：\n${lines.join('\n')}`)
	assert.ok(infoIndex > warnIndex, `info 沒有排在 warn 之後：\n${lines.join('\n')}`)
	assert.match(lines.at(-1), /^下一步：先解決 error；供應鏈核查未過就不安裝/)
})

test('json 報告：可解析且欄位齊全', async () => {
	const manifest = baseManifest({ scripts: { preinstall: 'node ./scripts/pre.js' } })
	const { client } = buildPackage(manifest, { files: { 'package/scripts/pre.js': 'console.log("no")\n' } })
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))

	const parsed = JSON.parse(renderAuditReport(result, { format: 'json' }))
	assert.equal(parsed.spec, 'clean-plugin@1.2.3')
	assert.equal(parsed.ok, false)
	assert.equal(parsed.verdict.install, 'block')
	assert.deepEqual(parsed.verdict.blocking, ['audit/install-script'])
	assert.ok(Array.isArray(parsed.verdict.checked))
	assert.ok(parsed.verdict.checked.includes('install-scripts'))
	assert.deepEqual(Object.keys(parsed.counts).sort(), ['error', 'info', 'warn'])
	assert.equal(parsed.findings.length, result.findings.length)
	assert.equal(parsed.findings[0].level, 'error')
	assert.equal(parsed.target.kind, 'registry')
	assert.equal(parsed.evidence.manifestSource, 'tarball')
	assert.equal(typeof parsed.evidence, 'object')
})

test('summary line：BLOCK 開頭並帶 blocking code；allow 則 ALLOW', async () => {
	const blocked = buildPackage(baseManifest({ scripts: { postinstall: 'node ./x.js' } }))
	const blockResult = await auditSpec('clean-plugin', options({ registryClient: blocked.client }))
	const blockLine = auditSummaryLine(blockResult)
	assert.match(blockLine, /^BLOCK \d+ error \d+ warn \d+ info/)
	assert.match(blockLine, /audit\/install-script/)

	const clean = buildPackage(baseManifest())
	const cleanResult = await auditSpec('clean-plugin', options({ registryClient: clean.client }))
	assert.match(auditSummaryLine(cleanResult), /^ALLOW 0 error 0 warn \d+ info/)
})

test('prepare 不算阻斷：registry tarball 安裝時 npm 不執行它', async () => {
	const { client } = buildPackage(baseManifest({ scripts: { prepare: 'npm run build:plugin' } }))
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.equal(result.verdict.install, 'allow')
	assert.equal(result.counts.error, 0)
	const finding = result.findings.find((entry) => entry.evidence?.script === 'prepare')
	assert.equal(finding.code, 'audit/publish-script')
	assert.equal(finding.level, 'info')
	assert.match(finding.hint, /不執行 prepare/u)
})

test('內建的依賴帶 postinstall：block（根 manifest 乾淨也沒用）', async () => {
	const { client } = buildPackage(baseManifest(), {
		files: {
			'package/node_modules/evil-gyp/package.json': JSON.stringify({
				name: 'evil-gyp',
				version: '1.0.0',
				scripts: { postinstall: 'node ./payload.js' },
			}),
		},
	})
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.equal(result.verdict.install, 'block')
	const finding = result.findings.find((entry) => entry.code === 'audit/install-script')
	assert.match(finding.message, /evil-gyp 的 postinstall/u)
	assert.equal(result.evidence.bundledManifests, 1)
})

test('bundle patch 含 !!js：warn（載入 profile 時會執行）', async () => {
	const { client } = buildPackage(
		baseManifest({ dsh: { bundle: { patch: './cordis.patch.yml' } } }),
		{ files: { 'package/cordis.patch.yml': "insert:\n  - id: evil\n    config: !!js require('node:fs')\n" } },
	)
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.equal(result.verdict.install, 'allow')
	const finding = result.findings.find((entry) => entry.code === 'audit/patch-js')
	assert.equal(finding.level, 'warn')
	assert.equal(result.evidence.bundlePatch, './cordis.patch.yml')
})

test('patch 指向的檔案不存在：warn patch-missing', async () => {
	const { client } = buildPackage(baseManifest({ dsh: { bundle: { patch: './missing.yml' } } }))
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.ok(result.findings.some((entry) => entry.code === 'audit/patch-missing'))
})

test('沒宣告 engines.dsh／DSH peer：說「沒有承諾」而不是 compat-ok', async () => {
	const { client } = buildPackage(baseManifest({ engines: undefined }))
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	const codes = result.findings.map((entry) => entry.code)
	assert.ok(codes.includes('audit/compat-undeclared'))
	assert.ok(!codes.includes('audit/compat-ok'))
	assert.equal(result.evidence.compat.declared, false)
})

test('只有 dist.integrity、沒有 shasum：仍然算核對通過', async () => {
	const { client } = buildPackage(baseManifest(), { shasum: '' })
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.equal(result.verdict.install, 'allow')
	assert.ok(result.findings.some((entry) => entry.code === 'audit/integrity-ok'))
	assert.ok(!result.findings.some((entry) => entry.code === 'audit/dist-missing'))
})

test('tarball 解析不了：block 而不是默默放過', async () => {
	const garbage = Buffer.from('this is not a tarball')
	// Integrity matches the bytes we serve, so only the parse can fail: that is the
	// case where an earlier version would have said "no scripts, looks fine".
	const { client } = buildPackage(baseManifest(), {
		tarball: async () => garbage,
		integrity: `sha512-${createHash('sha512').update(garbage).digest('base64')}`,
		shasum: createHash('sha1').update(garbage).digest('hex'),
	})
	const result = await auditSpec('clean-plugin@1.2.3', options({ registryClient: client }))
	assert.equal(result.verdict.install, 'block')
	assert.deepEqual(result.verdict.blocking, ['audit/tarball-unreadable'])
	assert.ok(result.findings.some((entry) => entry.code === 'audit/tarball-unreadable' && entry.level === 'error'))
})

test('tarball 內版本與 registry 不一致：warn manifest-mismatch', async () => {
	const manifest = baseManifest()
	const { client, tarball } = buildPackage(manifest)
	const mismatched = {
		...client,
		versionDoc: async () => ({
			name: 'clean-plugin',
			version: '1.2.4',
			manifest,
			dist: {
				tarball: 'https://registry.example.test/clean-plugin/-/clean-plugin-1.2.4.tgz',
				integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
				shasum: createHash('sha1').update(tarball).digest('hex'),
			},
			gitHead: 'abcdef0123456789abcdef0123456789abcdef01',
			publishTime: '2026-10-01T00:00:00.000Z',
			requestedRange: 'latest',
		}),
	}
	const result = await auditSpec('clean-plugin@1.2.4', options({ registryClient: mismatched }))
	assert.equal(result.verdict.install, 'allow')
	const finding = result.findings.find((entry) => entry.code === 'audit/manifest-mismatch')
	assert.equal(finding.level, 'warn')
	assert.match(finding.message, /1\.2\.4/u)
})

test('未核查的 spec：text 報告寫「未核查」，不寫「可以安裝」', async () => {
	const result = await auditSpec('./some/local-plugin', options({ profileDir: EMPTY_PROFILE }))
	const lines = renderAuditReport(result).split('\n')
	assert.equal(lines[0], 'plugin_audit ./some/local-plugin')
	assert.match(lines[1], /^結論：未核查 — /u)
	assert.doesNotMatch(lines[1], /可以安裝/u)
	assert.match(lines.at(-1), /不能當成通過/u)
	assert.match(auditSummaryLine(result), /^NOT-AUDITED/)
})
