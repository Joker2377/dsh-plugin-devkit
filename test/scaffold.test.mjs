import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { ScaffoldError, insertIdFor, scaffoldFiles, toSlug, toolNameFor } from '../lib/scaffold.js'
import { parsePatch } from '../lib/yaml.js'

/** @returns {Array<{ path: string, content: string }>} */
function build(options = {}) {
	return scaffoldFiles({ name: 'dsh-foo-bar', author: 'Tester', year: 2026, ...options })
}

/** @param {Array<{ path: string, content: string }>} files @param {string} path */
function contentOf(files, path) {
	const found = files.find((file) => file.path === path)
	assert.ok(found, `找不到 ${path}`)
	return found.content
}

test('產出的檔案涵蓋一個 bundle 需要的每一塊', () => {
	const paths = build().map((file) => file.path)
	for (const expected of [
		'package.json',
		'cordis.patch.yml',
		'lib/index.js',
		'lib/tools.js',
		'test/bundle.test.mjs',
		'README.md',
		'LICENSE',
		'.gitignore',
		'.github/workflows/test.yml'
	]) {
		assert.ok(paths.includes(expected), `缺 ${expected}`)
	}
	assert.equal(build({ ci: false }).some((file) => file.path.startsWith('.github/')), false)
})

test('manifest 宣告了 DSH 需要的欄位', () => {
	const manifest = JSON.parse(contentOf(build(), 'package.json'))
	assert.equal(manifest.name, 'dsh-foo-bar')
	assert.equal(manifest.type, 'module')
	assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
	assert.match(manifest.engines.dsh, /^>=/)
	assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-tools'])
	assert.equal(manifest.scripts.test, 'node --test "test/**/*.test.mjs"')
})

test('patch 插入一列，id 與模組名對得上', () => {
	const patch = parsePatch(contentOf(build(), 'cordis.patch.yml'))
	assert.deepEqual(patch.problems, [])
	assert.equal(patch.inserts.length, 1)
	assert.equal(patch.inserts[0].id, 'foo-bar')
	assert.equal(patch.inserts[0].name, 'dsh-foo-bar')
})

test('入口匯出 name/inject/apply，工具名帶外掛前綴', () => {
	const entry = contentOf(build(), 'lib/index.js')
	assert.match(entry, /export const name = 'dsh-foo-bar'/)
	assert.match(entry, /export const inject = \['tools'\]/)
	assert.match(entry, /export function apply\(ctx\)/)
	assert.match(contentOf(build(), 'lib/tools.js'), /name: 'foo_bar_hello'/)
	assert.equal(toolNameFor('dsh-foo-bar', 'hello'), 'foo_bar_hello')
	assert.equal(toolNameFor('@me/dsh-x', 'ping-pong'), 'x_ping_pong')
})

test('README 有安裝段——檢查器也要求的那一段', () => {
	const readme = contentOf(build(), 'README.md')
	assert.match(readme, /^## 安裝$/m)
	assert.match(readme, /^## 疑難排解$/m)
	assert.match(readme, /Plugins/)
	// dsh-plugin-workflow 的 check.mjs 要求這八段且照這個順序；骨架一產出就要過。
	const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1])
	assert.deepEqual(headings, ['功能', '安裝', '使用', '疑難排解', '運作原理', '開發', '已知限制', '授權'])
})

test('名稱與 slug 的正規化', () => {
	assert.equal(toSlug('dsh-foo-bar'), 'foo-bar')
	assert.equal(toSlug('@me/dsh-foo-bar'), 'foo-bar')
	assert.equal(insertIdFor('dsh-foo-bar'), 'foo-bar')
	// npm 名稱不接受大寫，這裡也不放行——早點失敗比事後改名好。
	assert.throws(() => scaffoldFiles({ name: '@me/dsh-Foo_Bar' }), ScaffoldError)
	assert.throws(() => scaffoldFiles({ name: 'Bad_Name' }), ScaffoldError)
	assert.throws(() => scaffoldFiles({}), ScaffoldError)
})

test('kind=events：沒有工具檔、沒有 inject、沒有 dsh peer；不認得的 kind 直接拒絕', () => {
	const files = build({ kind: 'events' })
	assert.equal(files.some((file) => file.path === 'lib/tools.js'), false)
	const entry = contentOf(files, 'lib/index.js')
	assert.doesNotMatch(entry, /export const inject/)
	assert.match(entry, /ctx\.on\('session\/event'/)
	assert.match(entry, /ctx\.on\('session\/disposed'/)
	assert.equal(JSON.parse(contentOf(files, 'package.json')).peerDependencies, undefined)
	assert.throws(() => build({ kind: 'client' }), ScaffoldError)
})

test('kind=events：假 tool/call 的 arguments 跟 host 一樣是 JSON 字串', () => {
	// Real session logs store tool/call.data.arguments as a JSON string; a fake object passes tests and breaks on the host.
	const generated = contentOf(build({ kind: 'events' }), 'test/bundle.test.mjs')
	assert.match(generated, /type: 'tool\/call'[^\n]*arguments: '\{\}'/)
})

/** Write a scaffold to a temp dir and run its own generated tests there. */
async function runGeneratedTests(options) {
	const dir = await mkdtemp(join(tmpdir(), 'devkit-scaffold-'))
	try {
		for (const file of build(options)) {
			const target = join(dir, file.path)
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, file.content, 'utf8')
		}
		const { spawnSync } = await import('node:child_process')
		// Without this the child inherits the parent runner's binary IPC stream instead of printing a report.
		const { NODE_TEST_CONTEXT: _, ...env } = process.env
		// Run the file directly: node:test still reports and sets the exit code, and no runner flag differs across Node 22/24.
		return spawnSync(process.execPath, ['test/bundle.test.mjs'], { cwd: dir, env, encoding: 'utf8' })
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

test('兩種骨架自帶的測試都能直接跑綠', async () => {
	for (const kind of ['tool', 'events']) {
		const run = await runGeneratedTests({ kind })
		assert.equal(run.status, 0, `${kind} 骨架的測試失敗：\n${run.stdout}\n${run.stderr}`)
	}
})

test('產出的 bundle 真的載得起來，apply() 與工具都跑得動', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'devkit-scaffold-'))
	try {
		for (const file of build()) {
			const target = join(dir, file.path)
			await mkdir(dirname(target), { recursive: true })
			await writeFile(target, file.content, 'utf8')
		}
		// 動態 import 就是語法檢查：模組載入得起來，產出的 JavaScript 就是合法的。
		const entry = await import(pathToFileURL(join(dir, 'lib/index.js')).href)
		assert.equal(entry.name, 'dsh-foo-bar')
		assert.deepEqual(entry.inject, ['tools'])

		const registered = []
		entry.apply({
			tools: {
				register: (definition) => {
					registered.push(definition)
					return () => {}
				}
			}
		})
		assert.deepEqual(registered.map((definition) => definition.name), ['foo_bar_hello'])
		assert.equal(await registered[0].execute({ whom: 'dsh' }), 'hello, dsh')
		assert.equal(await registered[0].execute({}), 'hello, world')
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
