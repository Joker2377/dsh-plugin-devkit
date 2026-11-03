/**
 * The skeleton a new DSH bundle starts from.
 *
 * Everything here is a pure function of its options — no filesystem, no clock
 * beyond an explicit `year`. `scaffoldFiles()` returns the exact file list, so
 * the same output can be asserted in tests, previewed with `dryRun`, and written
 * by the tool or the CLI without drifting apart.
 *
 * The shape it produces is the one the working bundles in this workspace use:
 * a host entry that exports `name` / `inject` / `apply`, tools defined in a
 * separate module behind a `defineTool` import that degrades outside DSH, a
 * patch that inserts one Loader row, and a README written as usage guidance.
 *
 * @module dsh-plugin-devkit/scaffold
 */

/** Bumped when the generated layout changes in a way a reader should notice. */
export const TEMPLATE_VERSION = 1

/** The README sections `plugin_doctor` looks for; keep the template and the check in step. */
export const README_SECTIONS = ['安裝', '使用', '疑難排解', '開發']

const NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Raised for caller-supplied options this generator refuses to guess about. */
export class ScaffoldError extends Error {}

/**
 * @param {unknown} name
 * @returns {string}
 */
function assertName(name) {
	const text = typeof name === 'string' ? name.trim() : ''
	if (!NAME_RE.test(text)) {
		throw new ScaffoldError(
			`套件名稱不合法：${JSON.stringify(name)}。用小寫字母、數字與 - . _，需要時加 @scope/。`
		)
	}
	return text
}

/**
 * The name without a scope and without a leading `dsh-`, in kebab case.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function toSlug(name) {
	const slug = assertName(name)
		.replace(/^@[^/]+\//, '')
		.replace(/^dsh-/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug === '' ? 'plugin' : slug
}

/**
 * The Loader row id the patch inserts. DSH treats it as the entry identity.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function insertIdFor(name) {
	return toSlug(name)
}

/**
 * The example tool name, namespaced by the bundle so two plugins cannot collide.
 *
 * @param {unknown} name
 * @param {string} [tool]
 * @returns {string}
 */
export function toolNameFor(name, tool = 'hello') {
	const prefix = toSlug(name).replace(/-/g, '_')
	const suffix = String(tool ?? 'hello')
		.trim()
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase()
	return `${prefix}_${suffix === '' ? 'hello' : suffix}`
}

/**
 * Build the file list for a new bundle.
 *
 * @param {object} options
 * @param {string} options.name package name; also the module the patch names
 * @param {string} [options.description] one line, used in the manifest and the header comment
 * @param {string} [options.tool] the example tool's suffix (`hello` by default)
 * @param {string} [options.author] copyright holder for LICENSE and `author`
 * @param {number} [options.year] copyright year; pass it so the output is reproducible
 * @param {boolean} [options.ci] include the GitHub Actions workflow (default true)
 * @returns {Array<{ path: string, content: string }>}
 */
export function scaffoldFiles(options = {}) {
	const name = assertName(options.name)
	const description = String(options.description ?? '').trim() || 'A DeepSeek Harness bundle.'
	const toolName = toolNameFor(name, options.tool ?? 'hello')
	const insertId = insertIdFor(name)
	const author = String(options.author ?? '').trim() || '<your name>'
	const year = Number.isSafeInteger(options.year) ? options.year : new Date().getFullYear()

	const files = [
		{ path: 'package.json', content: manifestFile({ name, description, author }) },
		{ path: 'cordis.patch.yml', content: patchFile({ name, insertId }) },
		{ path: 'lib/index.js', content: entryModule({ name, description }) },
		{ path: 'lib/tools.js', content: toolsModule({ name, toolName }) },
		{ path: 'test/bundle.test.mjs', content: bundleTest({ name, toolName }) },
		{ path: 'README.md', content: readmeFile({ name, description, toolName }) },
		{ path: 'LICENSE', content: mitLicense({ author, year }) },
		{ path: '.gitignore', content: 'node_modules/\n*.log\n.DS_Store\nThumbs.db\n' }
	]
	if (options.ci !== false) files.push({ path: '.github/workflows/test.yml', content: ciWorkflow() })
	return files
}

/**
 * @param {{ name: string, description: string, author: string }} fields
 * @returns {string}
 */
function manifestFile({ name, description, author }) {
	return `${JSON.stringify(
		{
			name,
			version: '0.1.0',
			description,
			type: 'module',
			main: './lib/index.js',
			exports: {
				'.': './lib/index.js',
				'./package.json': './package.json'
			},
			files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
			keywords: ['dsh-plugin', 'deepseek-harness'],
			author,
			license: 'MIT',
			engines: {
				node: '>=22.19',
				// DSH decides compatibility from this range alone when it is present;
				// it is what stops the bundle from loading on a Host it never ran on.
				dsh: '>=0.1.1-rc.2 <0.3.0'
			},
			peerDependencies: {
				// Same window the official tool packages publish.
				'@deepseek-ai/dsh-tools': '>=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0'
			},
			scripts: {
				test: 'node --test test/'
			},
			dsh: {
				bundle: {
					patch: './cordis.patch.yml'
				}
			}
		},
		null,
		2
	)}\n`
}

/**
 * @param {{ name: string, insertId: string }} fields
 * @returns {string}
 */
function patchFile({ name, insertId }) {
	return [
		`# ${name} — 一行說明這個 bundle 做什麼`,
		'#',
		`# 載入 profile 時插入一列：entry id 是 ${insertId}，模組是套件名。`,
		'# 有 Config 的外掛才需要 config；沒有 Config 時留 {} 即可。',
		'- insert:',
		`    - id: ${insertId}`,
		`      name: ${name}`,
		'      config: {}',
		''
	].join('\n')
}

/**
 * @param {{ name: string, description: string }} fields
 * @returns {string}
 */
function entryModule({ name, description }) {
	return [
		'/**',
		` * ${name} — ${description}`,
		' *',
		' * 這個檔案是 DSH 載入的入口：patch 的 insert 指到套件名，套件名指到 main。',
		' * 外掛只做兩件事——宣告 identity，然後在 apply() 裡把能力掛上去。',
		' */',
		"import { createExampleTool } from './tools.js'",
		'',
		`export const name = '${name}'`,
		'',
		'/** 需要工具註冊表，ctx.tools.register() 才存在。 */',
		"export const inject = ['tools']",
		'',
		'/**',
		' * @param {import(\'@deepseek-ai/cordis\').Context} ctx',
		' */',
		'export function apply(ctx) {',
		'\tctx.tools.register(createExampleTool())',
		'}',
		''
	].join('\n')
}

/**
 * @param {{ name: string, toolName: string }} fields
 * @returns {string}
 */
function toolsModule({ name, toolName }) {
	return [
		'/**',
		` * ${name} 的工具定義。`,
		' *',
		' * defineTool 在 DSH 內由 @deepseek-ai/dsh-tools 提供。脫離 App 直接跑測試時退回恆等',
		' * 實現，所以這個模組可以被純 node 匯入——npm test 不需要安裝任何依賴。',
		' */',
		"const { defineTool } = await import('@deepseek-ai/dsh-tools')",
		'\t.catch(() => ({ defineTool: (definition) => definition }))',
		'',
		'export function createExampleTool() {',
		'\treturn defineTool({',
		`\t\tname: '${toolName}',`,
		"\t\t// 換掉這行：模型什麼時候該呼叫它、會拿到什麼。一行一個事實，不要寫成廣告。",
		"\t\tdescription: '說出這個工具的用途與回傳內容。',",
		'\t\tparameters: {',
		'\t\t\twhom: {',
		"\t\t\t\ttype: 'string',",
		"\t\t\t\tdescription: '要打招呼的對象，預設 world。',",
		'\t\t\t},',
		'\t\t},',
		'\t\toutput: {',
		"\t\t\tschema: { type: 'string' },",
		"\t\t\trender: (_args, value) => [{ type: 'text', text: value }],",
		'\t\t},',
		'\t\t// 純字串運算、不碰共享狀態才可以並行；有 IO 或全域寫入時拿掉這行。',
		'\t\tisConcurrencySafe: () => true,',
		'\t\tasync execute(args) {',
		"\t\t\tconst whom = String(args?.whom ?? '').trim() || 'world'",
		"\t\t\treturn 'hello, ' + whom",
		'\t\t},',
		'\t})',
		'}',
		''
	].join('\n')
}

/**
 * @param {{ name: string, toolName: string }} fields
 * @returns {string}
 */
function bundleTest({ name, toolName }) {
	return [
		"import assert from 'node:assert/strict'",
		"import test from 'node:test'",
		'',
		"import { apply, inject, name } from '../lib/index.js'",
		'',
		'/** 最小可用的假 ctx：只實作 apply() 真的會碰到的東西。 */',
		'function fakeContext() {',
		'\tconst registered = []',
		'\treturn {',
		'\t\tregistered,',
		'\t\tctx: {',
		'\t\t\ttools: {',
		'\t\t\t\tregister: (definition) => {',
		'\t\t\t\t\tregistered.push(definition)',
		'\t\t\t\t\treturn () => {}',
		'\t\t\t\t}',
		'\t\t\t}',
		'\t\t}',
		'\t}',
		'}',
		'',
		"test('外掛宣告了 DSH 需要的 identity 與 service', () => {",
		`\tassert.equal(name, '${name}')`,
		"\tassert.ok(Array.isArray(inject) && inject.includes('tools'))",
		'})',
		'',
		"test('apply() 註冊工具，且工具能跑', async () => {",
		'\tconst { ctx, registered } = fakeContext()',
		'\tapply(ctx)',
		'\tassert.equal(registered.length, 1)',
		`\tassert.equal(registered[0].name, '${toolName}')`,
		"\tassert.equal(await registered[0].execute({ whom: 'dsh' }), 'hello, dsh')",
		'});',
		'',
		"test('工具在參數缺省時仍回得出結果', async () => {",
		'\tconst { ctx, registered } = fakeContext()',
		'\tapply(ctx)',
		"\tassert.equal(await registered[0].execute({}), 'hello, world')",
		'})',
		''
	].join('\n')
}

/**
 * The README template is deliberately written the way a reader needs it: what
 * this is, how to install it, how to use it, what goes wrong, how to work on it.
 *
 * @param {{ name: string, description: string, toolName: string }} fields
 * @returns {string}
 */
function readmeFile({ name, description, toolName }) {
	return [
		`# ${name}`,
		'',
		`*${description}*`,
		'',
		'一句話說清楚：裝了它之後，什麼事情會變得不一樣。讀者通常是先用看看的人，不是維護者。',
		'',
		'## 功能',
		'',
		`- **${toolName}** — 換成這個工具真的幫使用者做完的事。`,
		'- **（第二個能力）** — 一項一行，寫使用者看得見的結果，不寫實作細節。',
		'',
		'## 安裝',
		'',
		'就一個連結。',
		'',
		'1. 複製倉庫網址：',
		'',
		'   ```text',
		'   https://github.com/<owner>/<repo>',
		'   ```',
		'',
		'2. 在 DSH 側邊欄打開 **Plugins**，把網址貼進安裝欄位，按 **Install**。',
		'3. 重新載入 App。',
		'',
		'> [!IMPORTANT]',
		'> 貼倉庫**首頁**網址。`https://github.com/.../tree/main` 這類頁面網址會被拒絕。',
		'',
		'## 使用',
		'',
		'說明它怎麼被觸發、使用者需要知道什麼。一次講一個情境，不要列 API 清單。',
		'',
		'## 疑難排解',
		'',
		'| 症狀 | 可能原因 | 處理 |',
		'| --- | --- | --- |',
		'| 外掛沒反應 | 未載入或被停用 | 重載 App，檢查日誌有沒有這個外掛的 warn |',
		'| （另一個症狀） | （原因） | （做法） |',
		'',
		'## 開發',
		'',
		'```bash',
		'npm test                 # 不需要安裝依賴，也不需要 DSH',
		'```',
		'',
		'## 已知限制',
		'',
		'- 先寫你真的沒做的部分。沒有這一段，讀者會假設它什麼都能做。',
		''
	].join('\n')
}

/**
 * @param {{ author: string, year: number }} fields
 * @returns {string}
 */
function mitLicense({ author, year }) {
	return [
		'MIT License',
		'',
		`Copyright (c) ${year} ${author}`,
		'',
		'Permission is hereby granted, free of charge, to any person obtaining a copy',
		'of this software and associated documentation files (the "Software"), to deal',
		'in the Software without restriction, including without limitation the rights',
		'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
		'copies of the Software, and to permit persons to whom the Software is',
		'furnished to do so, subject to the following conditions:',
		'',
		'The above copyright notice and this permission notice shall be included in all',
		'copies or substantial portions of the Software.',
		'',
		'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
		'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
		'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
		'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
		'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
		'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
		'SOFTWARE.',
		''
	].join('\n')
}

/**
 * @returns {string}
 */
function ciWorkflow() {
	return [
		'name: test',
		'',
		'on:',
		'  push:',
		'    branches: [main]',
		'  pull_request:',
		'',
		'permissions:',
		'  contents: read',
		'',
		'jobs:',
		'  test:',
		'    runs-on: ${{ matrix.os }}',
		'    timeout-minutes: 10',
		'    strategy:',
		'      fail-fast: false',
		'      matrix:',
		'        os: [ubuntu-latest, windows-latest]',
		'        node-version: [22.x, 24.x]',
		'    steps:',
		'      - uses: actions/checkout@v4',
		'      - uses: actions/setup-node@v4',
		'        with:',
		'          node-version: ${{ matrix.node-version }}',
		'      # 不安裝依賴：測試只 import node: builtins 與 lib/。',
		'      - name: Syntax check',
		'        run: node --check lib/index.js',
		'      - name: Tests',
		'        run: npm test',
		''
	].join('\n')
}
