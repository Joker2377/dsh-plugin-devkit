/**
 * readProject must expand a glob export target into the real files it covers,
 * so `diagnose()` can verify a wildcard path against what is actually there.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { diagnose } from '../lib/checks.js'
import { readProject } from '../lib/project.js'

/**
 * A throwaway directory that disappears with the test.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function tempDir(t) {
	const dir = await mkdtemp(join(tmpdir(), 'devkit-project-'))
	t.after(() => rm(dir, { recursive: true, force: true }))
	return dir
}

test('readProject 把 exports 萬用字元路徑展開成實際檔案', async (t) => {
	const dir = await tempDir(t)
	await mkdir(join(dir, 'lib'))
	await writeFile(join(dir, 'lib/index.js'), "export const name = 'dsh-foo-bar'\nexport function apply() {}\n", 'utf8')
	await mkdir(join(dir, 'locale'))
	await writeFile(join(dir, 'locale/zh.json'), '{}\n', 'utf8')
	await writeFile(join(dir, 'locale/en.json'), '{}\n', 'utf8')
	await writeFile(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: foo-bar\n      name: dsh-foo-bar\n      config: {}\n', 'utf8')
	await writeFile(join(dir, 'README.md'), '# dsh-foo-bar\n\n## 安裝\n\nnpm i dsh-foo-bar\n', 'utf8')
	await writeFile(join(dir, 'package.json'), JSON.stringify({
		name: 'dsh-foo-bar',
		version: '1.0.0',
		type: 'module',
		main: './lib/index.js',
		exports: { '.': './lib/index.js', './locale/*.json': './locale/*.json' },
		dsh: { bundle: { patch: './cordis.patch.yml' } }
	}, null, 2), 'utf8')

	const project = await readProject(dir)
	assert.ok(project.files['locale/zh.json'] !== undefined, '快照缺 locale/zh.json')
	assert.ok(project.files['locale/en.json'] !== undefined, '快照缺 locale/en.json')
	assert.equal(
		diagnose({ files: project.files }).findings.some((finding) => finding.code === 'manifest/exports-missing'),
		false
	)
})
