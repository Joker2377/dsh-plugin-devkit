import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { collisionFindings, readProfile } from '../lib/profile.js'

/**
 * A throwaway directory that disappears with the test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
async function tempDir(t, prefix = 'devkit-profile-') {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	t.after(() => rm(dir, { recursive: true, force: true }))
	return dir
}

/**
 * @param {string} dir
 * @param {string} relativePath
 * @param {object} value
 * @returns {Promise<string>} the path written
 */
async function writeJson(dir, relativePath, value) {
	const path = join(dir, relativePath)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
	return path
}

/**
 * @param {object} [overrides]
 * @returns {object} a minimal profile manifest
 */
function profileManifest(overrides = {}) {
	return { name: 'desktop', version: '0.0.1', private: true, dependencies: {}, ...overrides }
}

/**
 * Hash every file under `dir`, so a test can prove nothing was written.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function hashTree(dir) {
	const lines = []
	/**
	 * @param {string} current
	 * @param {string} prefix
	 */
	async function walk(current, prefix) {
		const entries = await readdir(current, { withFileTypes: true })
		entries.sort((left, right) => (left.name < right.name ? -1 : 1))
		for (const entry of entries) {
			const full = join(current, entry.name)
			const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (entry.isDirectory()) {
				await walk(full, relativePath)
				continue
			}
			const digest = createHash('sha256').update(await readFile(full)).digest('hex')
			lines.push(`${relativePath} ${digest}`)
		}
	}
	await walk(dir, '')
	return lines.join('\n')
}

test('readProfile 讀出依賴來源、link: 目標版本與 bundles', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'local-extra/package.json', { name: 'dsh-taskbar-status', version: '0.5.0' })
	await writeJson(dir, 'node_modules/@deepseek-ai/dsh-tools/package.json', {
		name: '@deepseek-ai/dsh-tools',
		version: '0.2.1-rc.5',
	})
	await writeJson(
		dir,
		'package.json',
		profileManifest({
			dependencies: {
				'dsh-taskbar-status': 'link:./local-extra',
				'@deepseek-ai/dsh-tools': '^0.2.1-rc.5',
				'left-pad': '^1.0.0',
				'broken-link': 'link:./nope',
				'ws-dep': 'workspace:^1.0.0',
				'gh-dep': 'github:owner/repo',
				'file-dep': 'file:./local-extra',
			},
			dsh: { profile: { bundles: ['dsh-taskbar-status', 42, '@local/x'] } },
		})
	)

	const profile = await readProfile(dir)
	assert.equal(profile.installed, true)
	assert.equal(profile.root, resolve(dir))
	assert.equal(profile.hostVersion, '^0.2.1-rc.5')
	assert.deepEqual(profile.bundles, ['dsh-taskbar-status', '@local/x'])
	assert.equal(profile.dependencies['dsh-taskbar-status'].kind, 'link')
	assert.equal(profile.dependencies['dsh-taskbar-status'].raw, 'link:./local-extra')
	assert.equal(profile.dependencies['dsh-taskbar-status'].version, '0.5.0')
	assert.equal(profile.dependencies['dsh-taskbar-status'].resolvedPath, join(dir, 'local-extra'))
	assert.equal(profile.dependencies['file-dep'].kind, 'file')
	assert.equal(profile.dependencies['file-dep'].version, '0.5.0')
	assert.equal(profile.dependencies['ws-dep'].kind, 'workspace')
	assert.equal(profile.dependencies['gh-dep'].kind, 'github')
	// 範圍依賴的實際版本來自 node_modules；沒裝就沒有 version。
	assert.equal(profile.dependencies['@deepseek-ai/dsh-tools'].kind, 'range')
	assert.equal(profile.dependencies['@deepseek-ai/dsh-tools'].version, '0.2.1-rc.5')
	assert.equal(profile.dependencies['left-pad'].version, undefined)
	// link: 指向不存在的目錄只留 undefined，不丟錯。
	assert.equal(profile.dependencies['broken-link'].version, undefined)
})

test('dir 是上一層時，讀唯一的子目錄 package.json', async (t) => {
	const root = await tempDir(t)
	await writeJson(root, 'desktop/package.json', profileManifest())
	const profile = await readProfile(root)
	assert.equal(profile.installed, true)
	assert.equal(profile.root, join(root, 'desktop'))
})

test('profile 不存在時回 installed:false 的空結構，不丟錯', async (t) => {
	const root = await tempDir(t)
	const profile = await readProfile(join(root, 'missing-profile'))
	assert.equal(profile.installed, false)
	assert.equal(profile.manifest, undefined)
	assert.deepEqual(profile.dependencies, {})
	assert.deepEqual(profile.bundles, [])
	assert.equal(profile.root, resolve(root, 'missing-profile'))

	const findings = collisionFindings({ candidate: { name: 'dsh-foo' }, profile, candidateName: 'dsh-foo', candidateVersion: '1.0.0' })
	assert.equal(findings.length, 1)
	assert.equal(findings[0].code, 'audit/profile-absent')
	assert.equal(findings[0].level, 'info')
})

test('已安裝版本不符候選範圍 → profile-collision（error）', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'node_modules/dsh-core/package.json', { name: 'dsh-core', version: '1.2.0' })
	await writeJson(dir, 'node_modules/pinned-helper/package.json', { name: 'pinned-helper', version: '5.0.0' })
	await writeJson(dir, 'package.json', profileManifest({ dependencies: { 'dsh-core': '^1.0.0', 'pinned-helper': '5.0.0' } }))
	const profile = await readProfile(dir)
	assert.equal(profile.dependencies['dsh-core'].version, '1.2.0')
	assert.equal(profile.dependencies['pinned-helper'].version, '5.0.0')

	const findings = collisionFindings({
		candidate: {
			name: 'dsh-candidate',
			dependencies: { 'dsh-core': '^2.0.0' },
			peerDependencies: { 'pinned-helper': '^6.0.0' },
		},
		profile,
		candidateName: 'dsh-candidate',
		candidateVersion: '0.1.0',
	})
	const collisions = findings.filter((finding) => finding.code === 'audit/profile-collision')
	assert.equal(collisions.length, 2)
	assert.ok(collisions.every((finding) => finding.level === 'error'))
	assert.match(collisions[0].message, /dsh-core@1\.2\.0/)
	assert.match(collisions[0].message, /\^2\.0\.0/)
	assert.ok(!findings.some((finding) => finding.code === 'audit/profile-absent'))
})

test('候選範圍相容時沒有任何 finding', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'node_modules/dsh-core/package.json', { name: 'dsh-core', version: '1.2.0' })
	await writeJson(dir, 'package.json', profileManifest({ dependencies: { 'dsh-core': '^1.0.0' } }))
	const profile = await readProfile(dir)

	const findings = collisionFindings({
		candidate: { name: 'dsh-candidate', dependencies: { 'dsh-core': '>=1.0.0 <2.0.0' } },
		profile,
		candidateName: 'dsh-candidate',
		candidateVersion: '0.1.0',
	})
	assert.deepEqual(findings, [])
})

test('同名不同版本 → profile-upgrade（info），link: 要點明來源會換成 registry', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'local-extra/package.json', { name: 'my-bundle', version: '0.1.0' })
	await writeJson(dir, 'package.json', profileManifest({ dependencies: { 'my-bundle': 'link:./local-extra' } }))
	const profile = await readProfile(dir)

	const upgraded = collisionFindings({
		candidate: { name: 'my-bundle' },
		profile,
		candidateName: 'my-bundle',
		candidateVersion: '0.2.0',
	})
	assert.equal(upgraded.length, 1)
	assert.equal(upgraded[0].code, 'audit/profile-upgrade')
	assert.equal(upgraded[0].level, 'info')
	assert.match(upgraded[0].message, /link:\.\/local-extra/)
	assert.match(upgraded[0].message, /registry/)

	// 同版本就沒有 upgrade。
	const same = collisionFindings({
		candidate: { name: 'my-bundle' },
		profile,
		candidateName: 'my-bundle',
		candidateVersion: '0.1.0',
	})
	assert.deepEqual(same, [])
})

test('同名的 range 依賴被換版本 → profile-upgrade', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'node_modules/dsh-old/package.json', { name: 'dsh-old', version: '0.4.0' })
	await writeJson(dir, 'package.json', profileManifest({ dependencies: { 'dsh-old': '^0.4.0' } }))
	const profile = await readProfile(dir)

	const findings = collisionFindings({
		candidate: { name: 'dsh-old' },
		profile,
		candidateName: 'dsh-old',
		candidateVersion: '0.5.0',
	})
	assert.equal(findings.length, 1)
	assert.equal(findings[0].code, 'audit/profile-upgrade')
	assert.match(findings[0].message, /0\.4\.0/)
	assert.match(findings[0].message, /0\.5\.0/)
})

test('完全沒重疊 → profile-absent（info）', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'node_modules/dsh-core/package.json', { name: 'dsh-core', version: '1.2.0' })
	await writeJson(dir, 'package.json', profileManifest({ dependencies: { 'dsh-core': '^1.0.0' } }))
	const profile = await readProfile(dir)

	const findings = collisionFindings({
		candidate: { name: 'dsh-brand-new', dependencies: { unrelated: '^1.0.0' } },
		profile,
		candidateName: 'dsh-brand-new',
		candidateVersion: '0.1.0',
	})
	assert.equal(findings.length, 1)
	assert.equal(findings[0].code, 'audit/profile-absent')
	assert.equal(findings[0].level, 'info')
})

test('讀取與比對前後，profile 目錄的檔案雜湊不變（唯讀）', async (t) => {
	const dir = await tempDir(t)
	await writeJson(dir, 'local-extra/package.json', { name: 'my-bundle', version: '0.1.0' })
	await writeJson(dir, 'node_modules/dsh-core/package.json', { name: 'dsh-core', version: '1.2.0' })
	await writeJson(
		dir,
		'package.json',
		profileManifest({
			dependencies: { 'my-bundle': 'link:./local-extra', 'dsh-core': '^1.0.0' },
			dsh: { profile: { bundles: ['my-bundle'] } },
		})
	)

	const before = await hashTree(dir)
	const profile = await readProfile(dir)
	collisionFindings({
		candidate: { name: 'my-bundle', dependencies: { 'dsh-core': '^2.0.0' } },
		profile,
		candidateName: 'my-bundle',
		candidateVersion: '0.2.0',
	})
	const after = await hashTree(dir)
	assert.equal(after, before)
})
