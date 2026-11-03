/**
 * Talk to an npm-compatible registry, read-only.
 *
 * Three questions the audit needs answered before it may install anything:
 * which version does this spec resolve to, what exactly is in its tarball, and
 * does the registry hold a provenance attestation for it. All three are plain
 * HTTP GETs; nothing here writes, unpacks or executes package code.
 *
 * `fetch` is injectable so tests never touch the network. Every call carries an
 * `AbortSignal.timeout()` so a hung registry cannot hang the audit.
 *
 * @module dsh-plugin-devkit/registry
 */

import { compareVersions, parseVersion, satisfies } from './semver.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 15000
const JSON_ACCEPT = 'application/json'
const TARBALL_ACCEPT = 'application/octet-stream'

/**
 * Anything the registry side can go wrong with, in a shape the audit can map to
 * one finding: `code` says which one, `url` and `status` say where.
 */
export class RegistryError extends Error {
	/**
	 * @param {string} message one readable line
	 * @param {{ code?: string, url?: string, status?: number }} [details]
	 */
	constructor(message, { code = 'NETWORK', url, status } = {}) {
		super(message)
		this.name = 'RegistryError'
		this.code = code
		this.url = url
		this.status = status
	}
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * @param {any} response
 * @returns {number}
 */
function statusOf(response) {
	const status = Number(response?.status)
	return Number.isFinite(status) ? status : 0
}

/**
 * @param {any} response
 * @returns {boolean}
 */
function isOk(response) {
	if (typeof response?.ok === 'boolean') return response.ok
	const status = statusOf(response)
	return status >= 200 && status < 300
}

/**
 * Registry paths keep the `@` and only encode the scope separator, which is the
 * spelling npm itself uses: `@scope%2Fname`.
 *
 * @param {unknown} name
 * @returns {string}
 */
function packagePath(name) {
	const text = String(name ?? '')
	if (text.startsWith('@')) return text.replace('/', '%2F')
	return encodeURIComponent(text)
}

/**
 * @param {object} doc packument
 * @param {string} version
 * @returns {string | undefined}
 */
function publishTimeOf(doc, version) {
	const times = doc && typeof doc.time === 'object' && doc.time !== null ? doc.time : {}
	const value = times[version]
	return typeof value === 'string' ? value : undefined
}

/**
 * Highest published version that the range accepts. Prereleases take part, as
 * they do in DSH's own compatibility check.
 *
 * @param {string[]} candidates version strings from the packument
 * @param {string} range
 * @returns {string | undefined}
 */
function highestMatching(candidates, range) {
	let best
	let bestVersion
	for (const candidate of candidates) {
		const parsed = parseVersion(candidate)
		if (parsed === undefined) continue
		if (!satisfies(candidate, range)) continue
		if (best === undefined || compareVersions(parsed, bestVersion) > 0) {
			best = candidate
			bestVersion = parsed
		}
	}
	return best
}

/**
 * The predicate types an attestation document carries, deduplicated.
 *
 * @param {object} body
 * @returns {string[]}
 */
function predicateTypes(body) {
	const list = Array.isArray(body?.attestations) ? body.attestations : []
	const types = new Set()
	for (const entry of list) {
		if (entry && typeof entry.predicateType === 'string') types.add(entry.predicateType)
	}
	return [...types]
}

/**
 * Create a client bound to one registry and one `fetch`.
 *
 * @param {object} [options]
 * @param {string} [options.registry] base URL, no trailing slash needed
 * @param {typeof fetch} [options.fetch] injected for tests; defaults to global fetch
 * @param {number} [options.timeoutMs] per-request timeout; `0` disables it
 * @returns {{
 *   registry: string,
 *   packument: (name: string) => Promise<object>,
 *   versionDoc: (name: string, range?: string) => Promise<object>,
 *   tarball: (url: string) => Promise<Buffer>,
 *   attestations: (name: string, version: string) => Promise<object>,
 * }}
 */
export function createRegistryClient({ registry = DEFAULT_REGISTRY, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const fetcher = fetch
	if (typeof fetcher !== 'function') {
		throw new TypeError('createRegistryClient 需要可用的 fetch：請用 options.fetch 注入，或改用內建 global fetch 的 Node。')
	}
	const base = String(registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
	/** @type {Map<string, Promise<object>>} */
	const packuments = new Map()

	/**
	 * @param {string} accept
	 * @returns {object} fetch init
	 */
	const initFor = (accept) => {
		const init = { headers: { accept } }
		if (timeout > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
			init.signal = AbortSignal.timeout(timeout)
		}
		return init
	}

	/**
	 * @param {string} url
	 * @param {string} accept
	 * @returns {Promise<any>}
	 */
	const call = async (url, accept) => {
		try {
			return await fetcher(url, initFor(accept))
		} catch (error) {
			throw new RegistryError(`連不上 ${url}：${messageOf(error)}`, { code: 'NETWORK', url })
		}
	}

	/**
	 * @param {any} response
	 * @param {string} url
	 * @returns {Promise<any>}
	 */
	const readJson = async (response, url) => {
		const status = statusOf(response)
		try {
			if (typeof response.json === 'function') return await response.json()
			return JSON.parse(await response.text())
		} catch (error) {
			throw new RegistryError(`${url} 的回應不是合法 JSON：${messageOf(error)}`, { code: 'INVALID_JSON', url, status })
		}
	}

	/**
	 * @param {string} name
	 * @returns {Promise<object>}
	 */
	const loadPackument = async (name) => {
		const url = `${base}/${packagePath(name)}`
		const response = await call(url, JSON_ACCEPT)
		const status = statusOf(response)
		if (status === 404) {
			throw new RegistryError(`registry 找不到套件 ${name}`, { code: 'NOT_FOUND', url, status })
		}
		if (!isOk(response)) {
			throw new RegistryError(`registry 回應 HTTP ${status}：${url}`, { code: 'NETWORK', url, status })
		}
		const body = await readJson(response, url)
		if (typeof body !== 'object' || body === null || Array.isArray(body)) {
			throw new RegistryError(`${url} 的回應不是 packument 物件`, { code: 'INVALID_JSON', url, status })
		}
		return body
	}

	/**
	 * Raw packument, fetched once per client. A failed fetch is not remembered.
	 *
	 * @param {string} name
	 * @returns {Promise<object>}
	 */
	async function packument(name) {
		const key = String(name)
		if (!packuments.has(key)) {
			const pending = loadPackument(key)
			packuments.set(key, pending)
			pending.catch(() => {
				if (packuments.get(key) === pending) packuments.delete(key)
			})
		}
		return packuments.get(key)
	}

	/**
	 * Resolve a range to one published version and its manifest.
	 *
	 * @param {string} name
	 * @param {string} [range] `latest` uses `dist-tags.latest`
	 * @returns {Promise<{ name: string, version: string, manifest: object, dist: { tarball?: string, integrity?: string, shasum?: string }, gitHead?: string, publishTime?: string, deprecated?: string, requestedRange: string }>}
	 */
	async function versionDoc(name, range = 'latest') {
		const requestedRange = typeof range === 'string' && range.trim() !== '' ? range.trim() : 'latest'
		const doc = await packument(name)
		const url = `${base}/${packagePath(name)}`
		const versions = typeof doc.versions === 'object' && doc.versions !== null ? doc.versions : {}
		const distTags = typeof doc['dist-tags'] === 'object' && doc['dist-tags'] !== null ? doc['dist-tags'] : {}

		let version
		if (requestedRange === 'latest') {
			if (typeof distTags.latest === 'string' && distTags.latest !== '') version = distTags.latest
		} else {
			version = highestMatching(Object.keys(versions), requestedRange)
		}
		if (version === undefined) {
			throw new RegistryError(`套件 ${name} 沒有符合 ${requestedRange} 的已發佈版本`, {
				code: 'NO_MATCHING_VERSION',
				url,
				status: 200,
			})
		}

		const manifest = versions[version]
		if (typeof manifest !== 'object' || manifest === null) {
			throw new RegistryError(`套件 ${name} 的 packument 標了 ${version}，卻沒有這個版本的 manifest`, {
				code: 'NO_MATCHING_VERSION',
				url,
				status: 200,
			})
		}

		const dist = typeof manifest.dist === 'object' && manifest.dist !== null ? manifest.dist : {}
		return {
			name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : String(name),
			version,
			manifest,
			dist: { tarball: dist.tarball, integrity: dist.integrity, shasum: dist.shasum },
			gitHead: manifest.gitHead,
			publishTime: publishTimeOf(doc, version),
			deprecated: manifest.deprecated,
			requestedRange,
		}
	}

	/**
	 * Download one tarball into memory.
	 *
	 * @param {string} url
	 * @returns {Promise<Buffer>}
	 */
	async function tarball(url) {
		const target = String(url ?? '')
		if (target === '') throw new RegistryError('tarball 需要下載網址，但 dist.tarball 是空的', { code: 'NOT_FOUND', url: target })
		const response = await call(target, TARBALL_ACCEPT)
		const status = statusOf(response)
		if (status === 404) throw new RegistryError(`找不到 tarball：${target}`, { code: 'NOT_FOUND', url: target, status })
		if (!isOk(response)) {
			throw new RegistryError(`下載 tarball 失敗（HTTP ${status}）：${target}`, { code: 'NETWORK', url: target, status })
		}
		if (typeof response.arrayBuffer !== 'function') {
			throw new RegistryError(`下載 tarball 的回應無法讀成二進位：${target}`, { code: 'NETWORK', url: target, status })
		}
		let chunk
		try {
			chunk = await response.arrayBuffer()
		} catch (error) {
			throw new RegistryError(`讀取 tarball 內容失敗：${messageOf(error)}`, { code: 'NETWORK', url: target, status })
		}
		return Buffer.from(chunk)
	}

	/**
	 * Provenance attestations. A 404 is an ordinary "not published with one", not
	 * an error, so this never throws — the caller decides which finding it means.
	 *
	 * @param {string} name
	 * @param {string} version
	 * @returns {Promise<{ found: boolean, status: number, url: string, predicates: string[], raw: object | undefined }>}
	 */
	async function attestations(name, version) {
		const url = `${base}/-/npm/v1/attestations/${packagePath(name)}@${encodeURIComponent(String(version))}`
		let response
		try {
			response = await fetcher(url, initFor(JSON_ACCEPT))
		} catch {
			return { found: false, status: 0, url, predicates: [], raw: undefined }
		}
		const status = statusOf(response)
		if (status === 404 || !isOk(response)) {
			return { found: false, status, url, predicates: [], raw: undefined }
		}
		let body
		try {
			body = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text())
		} catch {
			return { found: false, status, url, predicates: [], raw: undefined }
		}
		if (typeof body !== 'object' || body === null) {
			return { found: false, status, url, predicates: [], raw: undefined }
		}
		// A 200 with an empty body (proxy, private mirror, broken implementation) is
		// not an attestation. `found` means "there is something to point at".
		const list = Array.isArray(body.attestations) ? body.attestations : []
		if (list.length === 0) {
			return { found: false, status, url, predicates: [], raw: body }
		}
		return { found: true, status, url, predicates: predicateTypes(body), raw: body }
	}

	return { registry: base, packument, versionDoc, tarball, attestations }
}
