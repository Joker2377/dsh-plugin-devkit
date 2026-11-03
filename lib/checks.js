/**
 * The diagnosis core: pure checks over a project snapshot.
 *
 * Input is a plain object of `relative path -> file content` (an absent key means
 * the file is missing). Nothing here touches the filesystem, so every rule can be
 * tested by handing it a hand-built snapshot, and `plugin_doctor` and the CLI
 * cannot diverge: both read a snapshot, then call this.
 *
 * The compatibility rule is not invented here. DSH refuses to install a bundle
 * when `engines.dsh` (alone, when present) or every `@deepseek-ai/dsh*` peer
 * (when it is not) rejects the running version — see `unmetRequirements()` in
 * `@deepseek-ai/dsh-app-boot`. `evaluateRequirements()` reproduces that exactly,
 * and the verdict is reported as a warning rather than an error because it is
 * about the Host the reader is running, not about the project's own soundness.
 *
 * @module dsh-plugin-devkit/checks
 */

import { parsePatch } from './yaml.js'
import { parseRange, parseVersion, satisfies } from './semver.js'

/** The package DSH treats as the Host itself. */
const DSH_SELF = '@deepseek-ai/dsh'
/** Every DSH package participates in the peer check. */
const DSH_PREFIX = '@deepseek-ai/dsh'
/** Layouts a test file realistically lives in. */
const TEST_FILE_RE = /^tests?\/[^/]+\.(?:test|spec)\.(?:mjs|cjs|js)$/
/** `## 安裝` / `## Install` in any casing or depth. */
const INSTALL_HEADING_RE = /^#{1,6}\s+.*(?:安裝|安装|install|getting started)/im
/** Tool packages a host plugin imports by name. */
const IMPORTED_RUNTIME_RE = /@deepseek-ai\/(dsh-[a-z0-9-]*)/g

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 }

/**
 * Strip a leading `./` and normalise separators so snapshot keys compare cleanly.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRel(value) {
	return String(value ?? '')
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+$/, '')
}

/**
 * Does this requirement set accept a running DSH version?
 *
 * Mirrors DSH:
 * - an own `engines.dsh` decides alone, and peers are then ignored;
 * - without it, every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must match;
 * - prereleases participate in ranges.
 *
 * @param {object} manifest parsed package.json
 * @param {string} runtimeVersion running DSH version
 * @returns {Array<{ field: string, range: string }>} the requirements not met
 */
export function evaluateRequirements(manifest, runtimeVersion) {
	const unmet = []
	const engines = manifest && typeof manifest.engines === 'object' && manifest.engines !== null
		? manifest.engines
		: {}
	if (typeof engines.dsh === 'string') {
		if (!satisfies(runtimeVersion, engines.dsh)) unmet.push({ field: 'engines.dsh', range: engines.dsh })
		return unmet
	}
	const peers = manifest && typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null
		? manifest.peerDependencies
		: {}
	for (const [name, range] of Object.entries(peers)) {
		if (name !== DSH_SELF && !name.startsWith(DSH_PREFIX)) continue
		if (typeof range !== 'string') {
			unmet.push({ field: `peerDependencies.${name}`, range: String(range) })
			continue
		}
		// `workspace:` ranges refer to the current runtime for peers only.
		const effective = /^workspace:[\^~*]$/.test(range) ? runtimeVersion : range
		if (!satisfies(runtimeVersion, effective)) unmet.push({ field: `peerDependencies.${name}`, range })
	}
	return unmet
}

/**
 * Run every check over one snapshot.
 *
 * @param {object} input
 * @param {Record<string, string>} [input.files] relative path -> content
 * @param {string} [input.hostVersion] running DSH version; enables the compatibility verdict
 * @returns {{
 *   findings: Array<{ level: 'error' | 'warn' | 'info', code: string, message: string, hint?: string }>,
 *   counts: { error: number, warn: number, info: number },
 *   ok: boolean,
 *   manifest: object | undefined,
 * }}
 */
export function diagnose({ files = {}, hostVersion } = {}) {
	/** @type {Array<{ level: 'error' | 'warn' | 'info', code: string, message: string, hint?: string }>} */
	const findings = []
	const add = (level, code, message, hint) => {
		findings.push(hint === undefined ? { level, code, message } : { level, code, message, hint })
	}

	const manifestText = files['package.json']
	let manifest
	if (manifestText === undefined) {
		add(
			'error',
			'manifest/missing',
			'沒有 package.json：DSH 只認得有 manifest 的套件，沒有它就無法安裝。',
			'先跑 plugin_scaffold，或在這個目錄補上 package.json。'
		)
	} else {
		try {
			manifest = JSON.parse(manifestText)
			if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
				add('error', 'manifest/json', 'package.json 的內容不是物件。')
				manifest = undefined
			}
		} catch (error) {
			add('error', 'manifest/json', `package.json 解析失敗：${error instanceof Error ? error.message : String(error)}`)
		}
	}

	if (manifest) checkManifest({ manifest, files, add })

	const patchPath = manifest && manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
	if (manifest && typeof patchPath === 'string') {
		const content = files[normalizeRel(patchPath)]
		if (content === undefined) {
			add('error', 'bundle/patch-missing', `dsh.bundle.patch 指向的 ${patchPath} 不存在。`)
		} else {
			checkPatch({ manifest, patchContent: content, files, add })
		}
	}

	if (manifest) checkEntry({ manifest, files, add })

	checkDocs({ files, add })
	if (manifest && hostVersion !== undefined) checkCompatibility({ manifest, hostVersion, add })

	findings.sort((left, right) => LEVEL_ORDER[left.level] - LEVEL_ORDER[right.level])
	const counts = { error: 0, warn: 0, info: 0 }
	for (const finding of findings) counts[finding.level] += 1
	return { findings, counts, ok: counts.error === 0, manifest }
}

/**
 * @param {object} input
 */
function checkManifest({ manifest, files, add }) {
	if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
		add('error', 'manifest/name', 'package.json 缺 name：DSH 用套件名當模組識別。')
	} else if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) {
		add('error', 'manifest/name', `套件名 ${JSON.stringify(manifest.name)} 不是合法的 npm 名稱。`)
	}

	if (parseVersion(manifest.version) === undefined) {
		add('error', 'manifest/version', `version ${JSON.stringify(manifest.version)} 不是 semver；DSH 的相容性判定需要它。`)
	}

	if (manifest.type !== 'module') {
		add('error', 'manifest/type', 'type 必須是 "module"：外掛以 ESM 載入。', '加上 "type": "module"。')
	}

	const main = typeof manifest.main === 'string' ? normalizeRel(manifest.main) : 'lib/index.js'
	if (files[main] === undefined) {
		add('error', 'manifest/main-missing', `main 指向的 ${main} 不存在。`)
	}

	if (manifest.exports !== undefined) {
		for (const [key, value] of Object.entries(manifest.exports ?? {})) {
			const target = typeof value === 'string' ? value : value && typeof value === 'object' ? value.default : undefined
			if (typeof target !== 'string') continue
			const rel = normalizeRel(target)
			if (rel === 'package.json') continue
			if (files[rel] === undefined) {
				add('error', 'manifest/exports-missing', `exports[${JSON.stringify(key)}] 指向的 ${target} 不存在。`)
			}
		}
	}

	if (manifest.dsh === undefined || manifest.dsh.bundle === undefined || typeof manifest.dsh.bundle.patch !== 'string') {
		add(
			'error',
			'bundle/patch-undeclared',
			'package.json 沒有宣告 dsh.bundle.patch：DSH 不會把它當 bundle 安裝。',
			'加上 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }。'
		)
	}

	const filesField = Array.isArray(manifest.files) ? manifest.files.map(normalizeRel) : undefined
	if (filesField !== undefined) {
		const coversLib = filesField.some((entry) => main === entry || main.startsWith(`${entry}/`))
		if (!coversLib) add('warn', 'manifest/files', `files 沒有涵蓋 ${main}：發佈出去的套件會缺入口檔。`)
		if (!filesField.includes('cordis.patch.yml')) {
			add('warn', 'manifest/files', 'files 沒有包含 cordis.patch.yml：安裝後找不到 patch。')
		}
	}

	const engines = typeof manifest.engines === 'object' && manifest.engines !== null ? manifest.engines : {}
	if (engines.dsh === undefined) {
		const peers = typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null
			? manifest.peerDependencies
			: {}
		const dshPeers = Object.keys(peers).filter((name) => name === DSH_SELF || name.startsWith(DSH_PREFIX))
		if (dshPeers.length === 0) {
			add(
				'warn',
				'compat/undeclared',
				'既沒有 engines.dsh 也沒有 @deepseek-ai/dsh* peer：DSH 不會做任何相容性判定，Host 升級後可能直接載入失敗。',
				'宣告 engines.dsh，寫上你實際測試過的 Host 版本範圍。'
			)
		}
	} else if (typeof engines.dsh !== 'string') {
		add('error', 'compat/engines-invalid', 'engines.dsh 必須是字串範圍。')
	} else if (!parseRange(engines.dsh).valid) {
		add('error', 'compat/engines-invalid', `engines.dsh ${JSON.stringify(engines.dsh)} 不是可解析的範圍：${parseRange(engines.dsh).reason}。`)
	}

	const entryContent = files[main] ?? ''
	for (const match of entryContent.matchAll(IMPORTED_RUNTIME_RE)) {
		const packageName = `@deepseek-ai/${match[1]}`
		const peers = typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null
			? manifest.peerDependencies
			: {}
		if (peers[packageName] === undefined) {
			add(
				'warn',
				'manifest/peer',
				`程式碼匯入了 ${packageName}，但沒有宣告成 peerDependency：安裝時不會被當成 Host 提供的能力。`,
				`在 peerDependencies 補上 ${JSON.stringify(packageName)}。`
			)
		}
	}

	const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : []
	if (!keywords.includes('dsh-plugin')) {
		add('info', 'manifest/keywords', 'keywords 建議加上 "dsh-plugin"，別人搜得到。')
	}
}

/**
 * @param {object} input
 */
function checkPatch({ manifest, patchContent, files, add }) {
	const patch = parsePatch(patchContent)
	if (patch.problems.length > 0) {
		add(
			'warn',
			'patch/unreadable',
			`patch 有 ${patch.problems.length} 處讀不懂：${patch.problems[0]}——這份檢查只看得懂 insert/override 的常見寫法，先人工看過這幾行。`
		)
	}
	if (patch.inserts.length === 0) {
		add('error', 'patch/insert-missing', 'patch 沒有任何 insert 項目：載入 profile 時不會插入這列。')
		return
	}

	const seen = new Set()
	for (const insert of patch.inserts) {
		if (insert.id === '' || !/^[a-z0-9][a-z0-9-]*$/.test(insert.id)) {
			add('error', 'patch/id', `insert id ${JSON.stringify(insert.id)} 不合法：用小寫字母、數字與 -。`)
			continue
		}
		if (seen.has(insert.id)) add('error', 'patch/id-duplicate', `insert id ${JSON.stringify(insert.id)} 重複。`)
		seen.add(insert.id)

		if (insert.name !== undefined && insert.name !== manifest.name) {
			add(
				'warn',
				'patch/name-mismatch',
				`insert 的 name 是 ${JSON.stringify(insert.name)}，套件名是 ${JSON.stringify(manifest.name)}：載入時會找不到模組。`,
				'兩邊寫成同一個套件名（或 scoped 全名）。'
			)
		}
	}

	const main = typeof manifest.main === 'string' ? normalizeRel(manifest.main) : 'lib/index.js'
	const entryContent = files[main] ?? ''
	const hasConfig = /export\s+const\s+Config\b/.test(entryContent)
	const configuredInsert = patch.inserts.find((insert) => insert.hasConfig && !/^\{\s*\}$/.test(insert.configText.trim()))
	if (configuredInsert !== undefined && !hasConfig) {
		add(
			'warn',
			'patch/config-unused',
			'patch 給了非空的 config，但模組沒有匯出 Config：這些設定會被忽略。',
			'要嘛匯出 Config（schemastery），要嘛把 config 留成 {}。'
		)
	}
}

/**
 * @param {object} input
 */
function checkEntry({ manifest, files, add }) {
	const main = typeof manifest.main === 'string' ? normalizeRel(manifest.main) : 'lib/index.js'
	const content = files[main]
	if (content === undefined) return // manifest/main-missing already reported it

	if (!/export\s+const\s+name\s*=/.test(content)) {
		add('error', 'entry/name-missing', `${main} 沒有匯出 name：Cordis 用它當外掛身份。`)
	} else {
		const declared = /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/.exec(content)
		if (declared && typeof manifest.name === 'string' && declared[1] !== manifest.name) {
			add(
				'warn',
				'entry/name-mismatch',
				`匯出的 name 是 ${JSON.stringify(declared[1])}，套件名是 ${JSON.stringify(manifest.name)}。`,
				'兩者一致比較不容易在日誌裡認錯外掛。'
			)
		}
	}

	if (!/export\s+(?:async\s+)?function\s+apply\b/.test(content) && !/export\s+const\s+apply\b/.test(content)) {
		add('error', 'entry/apply-missing', `${main} 沒有匯出 apply()：載入時沒有東西可以掛上去。`)
	}
}

/**
 * @param {object} input
 */
function checkDocs({ files, add }) {
	const readme = files['README.md']
	if (readme === undefined) {
		add('error', 'docs/readme-missing', '沒有 README.md：使用者無從知道怎麼裝、怎麼用。')
	} else if (!INSTALL_HEADING_RE.test(readme)) {
		add(
			'warn',
			'docs/install-section',
			'README 沒有安裝段：這個外掛的安裝方式是貼連結給 Plugins 頁，讀者不會自己猜到。',
			'加一節「安裝」，寫清楚複製哪個網址、貼到哪裡、要不要重載。'
		)
	}

	if (files['LICENSE'] === undefined) {
		add('warn', 'docs/license-missing', '沒有 LICENSE：別人要用你的外掛時不知道授權條件。')
	}

	const testFiles = Object.keys(files).filter((path) => TEST_FILE_RE.test(path))
	if (testFiles.length === 0) {
		add('warn', 'test/missing', '沒有任何測試檔：改動後只能靠人工確認。', '至少留一個 test/*.test.mjs，用 node --test 跑。')
	}

	if (Object.keys(files).some((path) => path.startsWith('.github/workflows/'))) return
	add('info', 'ci/missing', '沒有 CI workflow：push 之後沒有人幫你跑測試。')
}

/**
 * @param {object} input
 */
function checkCompatibility({ manifest, hostVersion, add }) {
	if (parseVersion(hostVersion) === undefined) {
		add('warn', 'compat/host-version', `hostVersion ${JSON.stringify(hostVersion)} 不是合法版本號，略過相容性判定。`)
		return
	}
	for (const { field, range } of evaluateRequirements(manifest, hostVersion)) {
		add(
			'warn',
			'compat/unmet',
			`${field} = ${range} 不接受執行中的 DSH ${hostVersion}：安裝時會以 incompatible-version 被拒。`,
			'調整範圍，或只在你真的測試過的 Host 版本上發佈。'
		)
	}
}
