/**
 * The supply-chain audit behind `plugin_audit`.
 *
 * One question: is it safe to install this third-party package into a profile?
 * This module reads the registry metadata, downloads the exact tarball, hashes
 * it, reads the manifest inside that tarball, and compares the result against
 * the running Host and the installed profile.
 *
 * Read-only by construction: no file is written, no package script is run and
 * npm is never spawned. The step order is frozen in `docs/audit-contract.md`;
 * each step catches its own error so a broken provenance endpoint cannot hide
 * an install script.
 *
 * @module dsh-plugin-devkit/audit
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { evaluateRequirements } from './checks.js'
import { collisionFindings, DEFAULT_PROFILE_DIR, readProfile } from './profile.js'
import { createRegistryClient } from './registry.js'
import { parseSpec } from './spec.js'
import { listTarEntries, readTarFile } from './tar.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** The check names `verdict.checked` may report, in contract order. */
const CHECK_NAMES = [
	'integrity',
	'install-scripts',
	'dependency-surface',
	'provenance',
	'githead',
	'dsh-compat',
	'profile-collision',
	'tarball-contents',
]

const INSTALL_SCRIPT_KEYS = ['preinstall', 'install', 'postinstall']
/**
 * npm runs `prepare` for git and local installs and when packing, but not when it
 * unpacks a registry tarball — so for the registry case it is context, not a block.
 */
const PREPARE_SCRIPT_KEYS = ['prepare']
const PUBLISH_SCRIPT_KEYS = ['prepublishOnly', 'prepack', 'prepublish']
/** A bundled dependency ships its own package.json inside the tarball. */
const BUNDLED_MANIFEST_RE = /(?:^|\/)node_modules\/.+\/package\.json$/
const BINARY_RE = /\.(?:node|exe|dll|so|dylib)$/i
/** A dependency range that cannot pin the bytes that will be installed. */
const LOOSE_SPEC_RE = /^(?:\*|latest|git\+|git:|github:|gitlab:|bitbucket:|git@)|^(?:https?|ssh):\/\/|\.git(?:#.*)?$/
/** A version nobody has touched for this long deserves a second look. */
const STALE_DAYS = 730

/**
 * @typedef {object} Finding
 * @property {'error' | 'warn' | 'info'} level
 * @property {string} code
 * @property {string} message
 * @property {string} [hint]
 * @property {object} [evidence]
 */

/**
 * @param {unknown} value
 * @returns {string | undefined} the trimmed string, or undefined when empty
 */
function nonEmptyString(value) {
	if (typeof value !== 'string') return undefined
	const text = value.trim()
	return text === '' ? undefined : text
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
	if (error instanceof Error) return error.message
	return String(error)
}

/**
 * Accept a Date, a timestamp or an ISO string; anything else reads as absent.
 *
 * @param {unknown} value
 * @returns {Date | undefined}
 */
function toDate(value) {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value
	if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
	if (typeof value === 'string' && value.trim() !== '') {
		const date = new Date(value)
		return Number.isNaN(date.getTime()) ? undefined : date
	}
	return undefined
}

/**
 * Hash the tarball with every algorithm the registry declared, so a mismatch
 * names the field and the algorithm instead of just saying "bad".
 *
 * @param {Buffer} buffer the downloaded tarball bytes
 * @param {object} dist the registry `dist` object
 * @returns {Array<{ field: string, algorithm: string, expected: string, actual: string, ok: boolean }>}
 */
function verifyDigests(buffer, dist) {
	const checks = []
	const integrity = nonEmptyString(dist.integrity)
	if (integrity !== undefined) {
		for (const token of integrity.split(/\s+/)) {
			const dash = token.indexOf('-')
			if (dash <= 0) continue
			const algorithm = token.slice(0, dash)
			const expected = token.slice(dash + 1)
			if (expected === '') continue
			let actual
			try {
				actual = createHash(algorithm).update(buffer).digest('base64')
			} catch {
				continue
			}
			checks.push({ field: 'dist.integrity', algorithm, expected, actual, ok: actual === expected })
		}
	}
	const shasum = nonEmptyString(dist.shasum)
	if (shasum !== undefined) {
		const actual = createHash('sha1').update(buffer).digest('hex')
		checks.push({ field: 'dist.shasum', algorithm: 'sha1', expected: shasum.toLowerCase(), actual, ok: actual === shasum.toLowerCase() })
	}
	return checks
}

/**
 * @param {{ field: string, algorithm: string, expected: string, actual: string }} check
 * @returns {string}
 */
function describeDigest(check) {
	return `${check.field}（${check.algorithm}）宣告 ${check.expected.slice(0, 16)}…，實測 ${check.actual.slice(0, 16)}…`
}

/**
 * The repository URL, whether the manifest writes it as a string or an object.
 *
 * @param {object} manifest
 * @returns {string | undefined}
 */
function repositoryUrl(manifest) {
	const repository = manifest.repository
	if (typeof repository === 'string') return nonEmptyString(repository)
	if (isRecord(repository)) return nonEmptyString(repository.url)
	return undefined
}

/**
 * Build the commit URL when the repository is a GitHub one.
 *
 * @param {object} manifest
 * @param {string} sha
 * @returns {string | undefined}
 */
function commitUrlFor(manifest, sha) {
	const url = repositoryUrl(manifest)
	if (url === undefined) return undefined
	const cleaned = url
		.replace(/^git\+/, '')
		.replace(/^git@github\.com:/, 'https://github.com/')
		.replace(/^github:/, 'https://github.com/')
	const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(cleaned)
	if (!match) return undefined
	return `https://github.com/${match[1]}/${match[2]}/commit/${sha}`
}

/**
 * Candidate dependency names that the profile already pins.
 *
 * @param {object} manifest
 * @param {Record<string, object>} profileDependencies
 * @returns {string[]}
 */
function matchedDependencyNames(manifest, profileDependencies) {
	const names = new Set()
	for (const source of [manifest.dependencies, manifest.peerDependencies]) {
		if (!isRecord(source)) continue
		for (const name of Object.keys(source)) {
			if (Object.prototype.hasOwnProperty.call(profileDependencies, name)) names.add(name)
		}
	}
	return [...names].sort()
}

/**
 * Client options for `createRegistryClient`; `fetch` only when the caller gave one.
 *
 * @param {object} options
 * @param {string} registry
 * @returns {object}
 */
function registryClientOptions(options, registry) {
	const clientOptions = { registry }
	if (typeof options.fetch === 'function') clientOptions.fetch = options.fetch
	return clientOptions
}

/**
 * Audit one spec end to end.
 *
 * @param {string} spec `foo`, `foo@^1`, `github:owner/repo`, `./dir`, …
 * @param {{
 *   registry?: string,
 *   registryClient?: object,
 *   fetch?: typeof fetch,
 *   profileDir?: string,
 *   hostVersion?: string,
 *   cwd?: string,
 *   now?: Date | number | string,
 * }} [options] `registryClient` replaces the real client and is the only test hook
 * @returns {Promise<{
 *   ok: boolean,
 *   target: { spec: string, kind: string, name?: string, version?: string, source?: string },
 *   verdict: { install: 'allow' | 'block' | 'not-audited', blocking: string[], reason: string, checked: string[] },
 *   findings: Finding[],
 *   counts: { error: number, warn: number, info: number },
 *   evidence: object,
 * }>}
 */
export async function auditSpec(spec, options = {}) {
	const rawSpec = typeof spec === 'string' ? spec : ''
	const registry = nonEmptyString(options.registry) ?? DEFAULT_REGISTRY
	const hostVersion = nonEmptyString(options.hostVersion)
	const cwd = nonEmptyString(options.cwd) ?? process.cwd()
	const requestedProfileDir = nonEmptyString(options.profileDir) ?? DEFAULT_PROFILE_DIR
	const profileDir = isAbsolute(requestedProfileDir) ? requestedProfileDir : resolve(cwd, requestedProfileDir)
	const now = toDate(options.now) ?? new Date()

	/** @type {Finding[]} */
	const findings = []
	/** @type {string[]} */
	const checked = []

	/**
	 * @param {string} name
	 */
	const mark = (name) => {
		if (!checked.includes(name)) checked.push(name)
	}

	/**
	 * @param {Finding['level']} level
	 * @param {string} code
	 * @param {string} message
	 * @param {string} [hint]
	 * @param {object} [extra]
	 */
	const add = (level, code, message, hint, extra) => {
		const finding = { level, code, message }
		if (hint !== undefined) finding.hint = hint
		if (extra !== undefined) finding.evidence = extra
		findings.push(finding)
	}

	const evidence = {
		registry,
		dist: null,
		manifestSource: null,
		scripts: {},
		dependencies: {},
		optionalDependencies: {},
		peerDependencies: {},
		engines: {},
		gitHead: null,
		githeadVerified: false,
		commitUrl: null,
		provenance: null,
		compat: { hostVersion: hostVersion ?? null, unmet: [] },
		profile: { root: profileDir, installed: false, matched: [] },
		tarballFiles: { count: 0, paths: [] },
		publishTime: null,
	}

	/** @type {{ spec: string, kind: string, name?: string, version?: string, source?: string }} */
	const target = { spec: rawSpec, kind: 'invalid' }

	const finish = () => {
		const counts = { error: 0, warn: 0, info: 0 }
		for (const finding of findings) counts[finding.level] += 1

		/** @type {string[]} */
		const blocking = []
		for (const finding of findings) {
			if (finding.level === 'error' && !blocking.includes(finding.code)) blocking.push(finding.code)
		}

		const install = blocking.length > 0 ? 'block' : checked.length === 0 ? 'not-audited' : 'allow'
		const firstError = findings.find((finding) => finding.level === 'error')
		const reason = install === 'block'
			? firstError?.message ?? '有 error 級 finding'
			: install === 'not-audited'
				? `這個 spec（${target.kind}）沒有執行任何 registry 側檢查：不是通過，只是沒查`
				: `${checked.length} 項檢查通過，無阻斷項`

		const ordered = [...checked].sort((left, right) => CHECK_NAMES.indexOf(left) - CHECK_NAMES.indexOf(right))
		return {
			ok: install === 'allow',
			target,
			verdict: { install, blocking, reason, checked: ordered },
			findings,
			counts,
			evidence,
		}
	}

	// Step 1 — the spec itself decides whether the rest can run at all.
	let parsed
	try {
		parsed = parseSpec(rawSpec)
	} catch (error) {
		add(
			'error',
			'audit/spec-invalid',
			`無法解析 spec ${JSON.stringify(rawSpec)}：${errorMessage(error)}。`,
			'格式：foo、foo@1.2.3、@scope/name@^1、github:owner/repo 或 ./path。',
		)
		return finish()
	}

	if (!parsed || parsed.kind === 'invalid') {
		const detail = parsed && parsed.kind === 'invalid' && nonEmptyString(parsed.reason) !== undefined
			? parsed.reason
			: '無法辨識的形式'
		add(
			'error',
			'audit/spec-invalid',
			`無法解析 spec ${JSON.stringify(rawSpec)}：${detail}。`,
			'格式：foo、foo@1.2.3、@scope/name@^1、github:owner/repo 或 ./path。',
		)
		return finish()
	}

	target.kind = parsed.kind

	if (parsed.kind === 'local') {
		target.source = parsed.path
		add(
			'warn',
			'audit/spec-unsupported',
			`local spec（${parsed.path}）不在 registry 上：integrity、provenance、gitHead 都無從核對。`,
			'本機套件請用 plugin_doctor 檢查目錄結構；要供應鏈核查請指向已發佈的版本。',
		)
		return finish()
	}

	if (parsed.kind === 'git') {
		target.source = parsed.url
		add(
			'warn',
			'audit/spec-unsupported',
			`git spec（${parsed.url}）取得的是原始碼而不是發佈 tarball，registry 側的 integrity／provenance 檢查不適用。`,
			'要完整核查請安裝已發佈到 registry 的版本；或以 plugin_doctor 檢查 clone 下來的目錄。',
		)
		return finish()
	}

	target.name = parsed.name

	let client
	try {
		client = isRecord(options.registryClient) ? options.registryClient : createRegistryClient(registryClientOptions(options, registry))
	} catch (error) {
		add(
			'error',
			'audit/network',
			`建立 registry client 失敗：${errorMessage(error)}。`,
			'確認 registry 位址可連線，或稍後再試。',
		)
		return finish()
	}

	// Step 2 — resolve the exact version; without it nothing else can be checked.
	let version
	try {
		version = await client.versionDoc(parsed.name, parsed.range)
	} catch (error) {
		const code = isRecord(error) ? error.code : undefined
		if (code === 'NOT_FOUND') {
			add(
				'error',
				'audit/version-missing',
				`registry 上找不到套件 ${parsed.name}。`,
				'確認套件名與 registry；私人套件要先設定 registry 或認證。',
				{ status: error.status },
			)
		} else if (code === 'NO_MATCHING_VERSION') {
			add(
				'error',
				'audit/version-missing',
				`${parsed.name} 沒有符合 ${JSON.stringify(parsed.range)} 的版本。`,
				'換一個 range（例如 latest 或明確版本）再試。',
			)
		} else {
			add(
				'error',
				'audit/network',
				`查詢 ${parsed.name}@${parsed.range} 失敗：${errorMessage(error)}。`,
				'網路或 registry 暫時不可用；稍後再試或指定 registry。',
				{ status: isRecord(error) ? error.status : undefined },
			)
		}
		return finish()
	}

	if (!isRecord(version) || nonEmptyString(version.version) === undefined) {
		add(
			'error',
			'audit/version-missing',
			`${parsed.name} 的 registry 回應沒有可用的 version。`,
			'這個 registry 回應不完整；換一個 registry 或稍後再試。',
		)
		return finish()
	}

	target.version = version.version
	const dist = isRecord(version.dist) ? version.dist : {}
	evidence.dist = isRecord(version.dist) ? { ...version.dist } : null
	const tarballUrl = nonEmptyString(dist.tarball)
	target.source = tarballUrl ?? registry
	if (tarballUrl !== undefined) {
		// The registry chooses where the bytes come from; a third-party host is not
		// wrong (CDNs exist) but the reader should see it.
		try {
			const tarballHost = new URL(tarballUrl).host.toLowerCase()
			const registryHost = new URL(registry).host.toLowerCase()
			if (tarballHost !== registryHost) {
				add(
					'info',
					'audit/tarball-offhost',
					`tarball 由 ${tarballHost} 提供，不是 registry 主機 ${registryHost}。`,
					'CDN 是常見做法；但這個主機由 registry 決定，確認你信任它。',
					{ tarballHost, registryHost },
				)
			}
		} catch {
			// A malformed tarball URL fails at the download step with a clearer message.
		}
	}

	// Step 3 — the bytes, the hashes, then the file list.
	/** @type {Buffer | undefined} */
	let tarballBuffer
	/** @type {Array<{ path: string, size: number, type: string }>} */
	let entries = []

	if (tarballUrl === undefined) {
		add(
			'error',
			'audit/dist-missing',
			`registry 的 ${parsed.name}@${version.version} 沒有 dist.tarball：無法取得實際發佈的檔案。`,
			'這個版本可能不完整；換一個版本，或以 git spec 檢查原始碼。',
		)
	} else {
		try {
			tarballBuffer = Buffer.from(await client.tarball(tarballUrl))
		} catch (error) {
			add(
				'error',
				'audit/network',
				`下載 tarball 失敗：${errorMessage(error)}。`,
				`來源：${tarballUrl}`,
			)
		}
	}

	if (tarballBuffer !== undefined) {
		const integrity = nonEmptyString(dist.integrity)
		const shasum = nonEmptyString(dist.shasum)
		if (integrity === undefined && shasum === undefined) {
			add(
				'error',
				'audit/dist-missing',
				'registry 的 dist 既沒有 integrity 也沒有 shasum：這個版本沒有可核對的雜湊。',
				'沒有雜湊就無法確認下載到的位元組；不要安裝，改向作者索取發佈資訊。',
			)
		}

		try {
			const checks = verifyDigests(tarballBuffer, dist)
			if (checks.length > 0) mark('integrity')
			const failed = checks.filter((check) => !check.ok)
			const verifiedFields = new Set(checks.filter((check) => check.ok).map((check) => check.field))
			const integrityVerified = verifiedFields.has('dist.integrity')
			const shasumVerified = verifiedFields.has('dist.shasum')
			if (failed.length > 0) {
				add(
					'error',
					'audit/integrity-mismatch',
					`tarball 雜湊與 dist 不符：${failed.map(describeDigest).join('；')}。`,
					'下載到的位元組與 registry 宣告的不一致：不要安裝，回報給套件作者。',
					{ checks },
				)
			} else if (integrityVerified || shasumVerified) {
				const matched = []
				if (integrityVerified) matched.push(shasumVerified ? 'sha512 與 sha1 都' : 'sha512（registry 只給 integrity）都')
				else matched.push('只有 sha1')
				add(
					'info',
					'audit/integrity-ok',
					`${matched.join('')}與 dist 宣告一致（${checks.length} 個雜湊）。`,
					undefined,
					{ checks },
				)
			} else if (integrity !== undefined) {
				add(
					'error',
					'audit/dist-missing',
					'dist.integrity 的格式無法辨識：沒有可比對的 digest。',
					'這個 registry 回應不標準；不要只憑它安裝。',
				)
			}
		} catch (error) {
			add(
				'warn',
				'audit/tarball-unreadable',
				`計算 tarball 雜湊時失敗：${errorMessage(error)}。`,
				'無法核對 integrity；把下載到的檔案另外驗證後再安裝。',
			)
		}

		try {
			entries = listTarEntries(tarballBuffer)
			mark('tarball-contents')
			evidence.tarballFiles = {
				count: entries.length,
				paths: entries.slice(0, 200).map((entry) => entry.path),
			}
		} catch (error) {
			// A tarball this reader cannot unpack is a tarball whose scripts and
			// binaries cannot be inspected — an audit that skipped them is not a pass.
			add(
				'error',
				'audit/tarball-unreadable',
				`tarball 解析失敗：${errorMessage(error)}；integrity 仍以原始位元組計算。`,
				'內容無法檢視，安裝腳本與二進位檔都無法確認，因此不能放行；請人工解壓檢查。',
			)
		}
	}

	// Step 4 — the manifest that counts is the one inside the tarball.
	let manifest
	let manifestSource = 'registry'
	if (tarballBuffer !== undefined) {
		try {
			const raw = readTarFile(tarballBuffer, 'package.json')
			if (raw !== undefined) {
				const fromTarball = JSON.parse(Buffer.from(raw).toString('utf8'))
				if (isRecord(fromTarball)) {
					manifest = fromTarball
					manifestSource = 'tarball'
				}
			}
		} catch {
			// A manifest that cannot be read from the tarball falls back below.
			manifest = undefined
		}
	}
	if (manifest === undefined) {
		manifest = isRecord(version.manifest) ? version.manifest : {}
		manifestSource = 'registry'
	}
	evidence.manifestSource = manifestSource
	evidence.scripts = isRecord(manifest.scripts) ? { ...manifest.scripts } : {}
	evidence.dependencies = isRecord(manifest.dependencies) ? { ...manifest.dependencies } : {}
	evidence.optionalDependencies = isRecord(manifest.optionalDependencies) ? { ...manifest.optionalDependencies } : {}
	evidence.peerDependencies = isRecord(manifest.peerDependencies) ? { ...manifest.peerDependencies } : {}
	evidence.engines = isRecord(manifest.engines) ? { ...manifest.engines } : {}

	// The tarball is what npm unpacks; when it disagrees with the version the tag
	// resolved to, the tag and the bytes are describing different releases.
	try {
		const tarballVersion = nonEmptyString(manifest.version)
		const tarballName = nonEmptyString(manifest.name)
		evidence.tarballVersion = tarballVersion ?? null
		const mismatches = []
		if (tarballVersion !== undefined && tarballVersion !== version.version) {
			mismatches.push(`版本：registry 解析為 ${version.version}，tarball 內寫 ${tarballVersion}`)
		}
		if (tarballName !== undefined && tarballName !== parsed.name) {
			mismatches.push(`名稱：registry 是 ${parsed.name}，tarball 內寫 ${tarballName}`)
		}
		if (mismatches.length > 0) {
			add(
				'warn',
				'audit/manifest-mismatch',
				`tarball 內的 package.json 與 registry 不一致（${mismatches.join('；')}）。`,
				'下面所有腳本與依賴判斷都以 tarball 為準；這種不一致本身就是可疑訊號。',
				{ mismatches },
			)
		}
	} catch {
		// A malformed manifest is already handled by the fields read above.
	}

	// Step 5 — what the package runs on install, and what it needs compiled.
	mark('install-scripts')
	try {
		const scripts = isRecord(manifest.scripts) ? manifest.scripts : {}
		for (const key of INSTALL_SCRIPT_KEYS) {
			const command = nonEmptyString(scripts[key])
			if (command === undefined) continue
			add(
				'error',
				'audit/install-script',
				`package.json 帶 ${key} 腳本：${command}。`,
				'安裝時會執行這段程式碼。不要自動安裝，先人工讀過再決定。',
				{ script: key, command },
			)
		}
		for (const key of PUBLISH_SCRIPT_KEYS) {
			const command = nonEmptyString(scripts[key])
			if (command === undefined) continue
			add(
				'info',
				'audit/publish-script',
				`${key} 只在發佈時執行：${command}。`,
				undefined,
				{ script: key, command },
			)
		}
		for (const key of PREPARE_SCRIPT_KEYS) {
			const command = nonEmptyString(scripts[key])
			if (command === undefined) continue
			add(
				'info',
				'audit/publish-script',
				`package.json 帶 ${key} 腳本：${command}。`,
				'registry tarball 安裝時 npm 不執行 prepare（只在 git／本地安裝與發佈時跑）；列出來給你判斷，不算阻斷。',
				{ script: key, command },
			)
		}
		const gyp = entries.find((entry) => /(?:^|\/)binding\.gyp$/.test(entry.path))
		if (gyp !== undefined) {
			add(
				'warn',
				'audit/binding-gyp',
				'tarball 內有 binding.gyp：安裝時會在目標機器編譯原生模組。',
				'沒有對應的編譯工具鏈會安裝失敗；原生碼也無法從 tarball 審閱。',
				{ path: gyp.path },
			)
		}
		// Bundled dependencies ship inside the tarball, and npm still runs their
		// lifecycle scripts — a clean root manifest says nothing about them.
		const bundledEntries = entries
			.filter((entry) => entry.type === 'file' && BUNDLED_MANIFEST_RE.test(entry.path))
			.slice(0, 200)
		const bundledScripts = []
		for (const entry of bundledEntries) {
			try {
				const raw = readTarFile(tarballBuffer, entry.path)
				if (raw === undefined) continue
				const nested = JSON.parse(Buffer.from(raw).toString('utf8'))
				if (!isRecord(nested) || !isRecord(nested.scripts)) continue
				for (const key of INSTALL_SCRIPT_KEYS) {
					const command = nonEmptyString(nested.scripts[key])
					if (command === undefined) continue
					bundledScripts.push({ path: entry.path, name: nonEmptyString(nested.name) ?? entry.path, script: key, command })
				}
			} catch {
				// One unreadable nested manifest must not disable the whole scan.
			}
		}
		evidence.bundledManifests = bundledEntries.length
		if (bundledScripts.length > 0) {
			const listed = bundledScripts.slice(0, 3).map((entry) => `${entry.name} 的 ${entry.script}`).join('、')
			add(
				'error',
				'audit/install-script',
				`tarball 內建的依賴帶安裝腳本（${bundledScripts.length} 個）：${listed}。`,
				'內建的依賴在安裝時一樣會執行這些腳本：根 package.json 乾淨不代表安全。',
				{ bundled: bundledScripts },
			)
		}
		// A bundle patch is executed by the Loader, so `!!js` in it is code, not data.
		const bundlePatchPath = nonEmptyString(
			isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle) ? manifest.dsh.bundle.patch : undefined,
		)
		if (bundlePatchPath !== undefined) {
			evidence.bundlePatch = bundlePatchPath
			const rawPatch = readTarFile(tarballBuffer, bundlePatchPath.replace(/^\.\//, ''))
			const patchText = rawPatch === undefined ? undefined : Buffer.from(rawPatch).toString('utf8')
			if (patchText === undefined) {
				add(
					'warn',
					'audit/patch-missing',
					`package.json 指向 bundle patch ${bundlePatchPath}，但 tarball 內找不到這個檔案。`,
					'找不到 patch 就無法知道 Host 載入時會掛上什麼；向作者確認後再安裝。',
				)
			} else if (/!!js\b/.test(patchText)) {
				add(
					'warn',
					'audit/patch-js',
					`bundle patch ${bundlePatchPath} 含 !!js：載入 profile 時會執行其中的 JavaScript。`,
					'patch 由 Host 載入時執行，效果等同安裝腳本；先讀過那段程式碼。',
					{ bytes: patchText.length },
				)
			} else {
				add(
					'info',
					'audit/patch-ok',
					`bundle patch ${bundlePatchPath} 沒有 !!js（${patchText.length} bytes）。`,
					undefined,
					{ bytes: patchText.length },
				)
			}
		}
	} catch (error) {
		add(
			'warn',
			'audit/tarball-unreadable',
			`掃描安裝腳本時失敗：${errorMessage(error)}。`,
			'改以人工檢視 package.json 的 scripts。',
		)
	}

	// Step 6 — the shape of the dependency surface.
	mark('dependency-surface')
	try {
		const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {}
		const optional = isRecord(manifest.optionalDependencies) ? manifest.optionalDependencies : {}
		const dependencyCount = Object.keys(dependencies).length
		const optionalCount = Object.keys(optional).length
		add(
			'info',
			'audit/dep-count',
			`直接依賴 ${dependencyCount} 個、optionalDependencies ${optionalCount} 個。`,
			undefined,
			{ dependencies: dependencyCount, optional: optionalCount },
		)

		const loose = Object.entries(dependencies).filter(([, range]) => LOOSE_SPEC_RE.test(nonEmptyString(range) ?? ''))
		if (optionalCount > 0 || loose.length > 0) {
			const reasons = []
			if (optionalCount > 0) reasons.push(`optionalDependencies ${optionalCount} 個`)
			if (loose.length > 0) {
				const listed = loose.slice(0, 5).map(([name, range]) => `${name}@${range}`).join('、')
				reasons.push(`範圍無上限或指向 git：${listed}`)
			}
			add(
				'warn',
				'audit/dep-surface',
				`依賴面較寬：${reasons.join('；')}。`,
				'依賴會在安裝時一起抓進來，範圍越寬越難保證內容固定。',
				{ optional: optionalCount, loose: loose.map(([name]) => name) },
			)
		}
	} catch (error) {
		add(
			'warn',
			'audit/tarball-unreadable',
			`分析依賴面時失敗：${errorMessage(error)}。`,
			'改以人工檢視 package.json 的 dependencies。',
		)
	}

	// Step 7 — is this tarball linked to a build the author can prove?
	mark('provenance')
	try {
		const attestation = await client.attestations(parsed.name, version.version)
		const found = attestation?.found === true
		const status = typeof attestation?.status === 'number' ? attestation.status : found ? 200 : 0
		evidence.provenance = {
			found,
			status,
			url: nonEmptyString(attestation?.url) ?? null,
			predicates: Array.isArray(attestation?.predicates) ? [...attestation.predicates] : [],
		}
		if (found) {
			add(
				'info',
				'audit/provenance-ok',
				`registry 有 ${parsed.name}@${version.version} 的 provenance attestation。`,
				undefined,
				{ status },
			)
		} else if (status === 404) {
			add(
				'warn',
				'audit/provenance-missing',
				`registry 沒有 ${parsed.name}@${version.version} 的 provenance attestation（404）。`,
				'沒有 attestation 就無法證明 tarball 由某個 repo 或 CI 產生；提高警覺。',
				{ status },
			)
		} else {
			add(
				'warn',
				'audit/provenance-unreachable',
				`查詢 provenance 失敗（HTTP ${status === 0 ? '未知' : status}）：無法確認是否有 attestation。`,
				'registry 或 attestation 服務暫時不可用；稍後重試再判斷。',
				{ status },
			)
		}
	} catch (error) {
		evidence.provenance = { found: false, status: 0, url: null, predicates: [], error: errorMessage(error) }
		add(
			'warn',
			'audit/provenance-unreachable',
			`查詢 provenance 失敗：${errorMessage(error)}。`,
			'attestation 服務暫時不可用；稍後重試再判斷。',
		)
	}

	// Step 8 — gitHead is only a field here; no GitHub round trip is authorized.
	mark('githead')
	try {
		const gitHead = nonEmptyString(version.gitHead) ?? nonEmptyString(manifest.gitHead)
		evidence.gitHead = gitHead ?? null
		evidence.githeadVerified = false
		if (gitHead !== undefined) {
			const commitUrl = commitUrlFor(manifest, gitHead)
			evidence.commitUrl = commitUrl ?? null
			add(
				'info',
				'audit/githead-ok',
				`tarball 的 gitHead 是 ${gitHead.slice(0, 12)}（僅比對欄位存在，未向 GitHub 核對 commit）。`,
				commitUrl === undefined ? 'repository 不是 GitHub 形式，無法自動組出 commit 連結。' : `可自行核對：${commitUrl}`,
				{ gitHead, commitUrl: commitUrl ?? null },
			)
		} else {
			evidence.commitUrl = null
			add(
				'warn',
				'audit/githead-missing',
				'tarball 的 package.json 沒有 gitHead：無法把這個版本對回某個 commit。',
				'沒有 gitHead 就查不到對應的原始碼版本；要求作者補上並重新發佈。',
			)
		}
	} catch (error) {
		add(
			'info',
			'audit/githead-unreachable',
			`讀取 gitHead 時失敗：${errorMessage(error)}。`,
			'改以人工核對 registry 與 repository 的版本。',
		)
	}

	// Step 9 — would this Host accept it?
	if (hostVersion === undefined) {
		add(
			'warn',
			'audit/compat-missing',
			'沒有提供 host 版本：無法判定 engines.dsh／peerDependencies 是否接受這台機器。',
			'帶上 hostVersion（例如 0.2.1-rc.5）再跑一次。',
		)
		evidence.compat = { hostVersion: null, unmet: [] }
	} else {
		mark('dsh-compat')
		try {
			const unmet = evaluateRequirements(manifest, hostVersion)
			const engines = isRecord(manifest.engines) ? manifest.engines : {}
			const peers = isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {}
			const declaresEngines = Object.hasOwn(engines, 'dsh')
			const declaredPeers = Object.keys(peers).filter((name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
			const declared = declaresEngines || declaredPeers.length > 0
			evidence.compat = { hostVersion, unmet, declared }
			if (!declared && unmet.length === 0) {
				// Nothing was declared, so nothing was accepted: say that instead of "ok".
				add(
					'info',
					'audit/compat-undeclared',
					`套件沒有宣告 engines.dsh，也沒有 @deepseek-ai/dsh* peer：對 host ${hostVersion} 沒有任何相容性承諾。`,
					'未宣告不是錯，但 Host 升級後可能直接載入失敗；把它當成風險，不是保證。',
					{ hostVersion },
				)
			} else if (unmet.length === 0) {
				add(
					'info',
					'audit/compat-ok',
					`engines.dsh／DSH peers 接受 host ${hostVersion}。`,
					undefined,
					{ hostVersion },
				)
			} else {
				const listed = unmet.map((entry) => `${entry.field} ${entry.range}`).join('；')
				add(
					'error',
					'audit/compat-unmet',
					`host ${hostVersion} 不滿足：${listed}。`,
					'換成符合範圍的 host，或改用支援這個 Host 的套件版本。',
					{ hostVersion, unmet },
				)
			}
		} catch (error) {
			evidence.compat = { hostVersion, unmet: [] }
			add(
				'warn',
				'audit/compat-missing',
				`判定相容性時失敗：${errorMessage(error)}。`,
				'改以人工核對 package.json 的 engines.dsh 與 peerDependencies。',
			)
		}
	}

	// Step 10 — would it collide with what the profile already pins?
	let profile
	try {
		profile = await readProfile(profileDir)
	} catch (error) {
		evidence.profile = { root: profileDir, installed: false, matched: [] }
		add(
			'info',
			'audit/profile-absent',
			`讀不到 profile ${profileDir}：略過與現有安裝的撞車檢查。`,
			'用 profileDir 指定實際的 profile 目錄（含 package.json）再跑一次。',
			{ error: errorMessage(error) },
		)
	}

	if (profile !== undefined) {
		const profileDependencies = isRecord(profile?.dependencies) ? profile.dependencies : {}
		const candidateName = nonEmptyString(manifest.name) ?? parsed.name
		const candidateVersion = nonEmptyString(manifest.version) ?? version.version
		evidence.profile = {
			root: nonEmptyString(profile?.root) ?? profileDir,
			installed: Object.prototype.hasOwnProperty.call(profileDependencies, candidateName),
			matched: matchedDependencyNames(manifest, profileDependencies),
		}
		mark('profile-collision')
		try {
			const collisions = collisionFindings({ candidate: manifest, profile, candidateName, candidateVersion })
			if (Array.isArray(collisions)) findings.push(...collisions)
		} catch (error) {
			add(
				'info',
				'audit/profile-absent',
				`與 profile 的撞車檢查失敗：${errorMessage(error)}。`,
				'改以人工比對 profile 的 package.json。',
			)
		}
	}

	// Step 11 — binary payloads cannot be reviewed as source.
	try {
		const binaries = entries
			.filter((entry) => entry.type === 'file' && BINARY_RE.test(entry.path))
			.map((entry) => entry.path)
		if (binaries.length > 0) {
			add(
				'warn',
				'audit/binary',
				`tarball 內有 ${binaries.length} 個原生／執行檔（前 5 個）：${binaries.slice(0, 5).join('、')}。`,
				'二進位檔無法從原始碼審閱，也常綁定平台；確認來源後再安裝。',
				{ count: binaries.length, files: binaries.slice(0, 5) },
			)
		}
	} catch (error) {
		add(
			'warn',
			'audit/tarball-unreadable',
			`檢查二進位檔時失敗：${errorMessage(error)}。`,
			'改以下載 tarball 後人工檢視。',
		)
	}

	// Step 12 — age and deprecation: context, not a verdict.
	try {
		const publishTime = toDate(version.publishTime)
		evidence.publishTime = publishTime === undefined ? null : publishTime.toISOString()
		if (publishTime !== undefined) {
			const days = Math.floor((now.getTime() - publishTime.getTime()) / 86_400_000)
			if (days > STALE_DAYS) {
				add(
					'info',
					'audit/published',
					`這個版本發佈於 ${publishTime.toISOString().slice(0, 10)}，距今 ${days} 天（超過 ${STALE_DAYS} 天）。`,
					'可能有修過的新版；確認不是舊版本再安裝。',
					{ days },
				)
			}
		}
		const deprecated = version.deprecated
		if (deprecated !== undefined && deprecated !== null && deprecated !== false && String(deprecated).trim() !== '') {
			add(
				'info',
				'audit/deprecated',
				`registry 把這個版本標為 deprecated：${String(deprecated)}。`,
				'改用維護中的版本。',
			)
		}
	} catch (error) {
		add(
			'info',
			'audit/published',
			`無法判讀發佈時間：${errorMessage(error)}。`,
			'發佈時間只是參考，不影響 block／allow。',
		)
	}

	// Step 13 — counts and the verdict.
	return finish()
}
