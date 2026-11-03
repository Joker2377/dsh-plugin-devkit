import assert from 'node:assert/strict'
import test from 'node:test'

import { createRegistryClient, RegistryError } from '../lib/registry.js'

const REGISTRY = 'https://reg.test'
const PACKAGE_URL = `${REGISTRY}/demo-pkg`
const ATTESTATION_URL = `${REGISTRY}/-/npm/v1/attestations/demo-pkg@2.0.0`

/**
 * A fetch response carrying JSON. Passing an `Error` as the body makes `.json()`
 * reject, which is how an unreadable body is simulated.
 *
 * @param {unknown} body
 * @param {number} [status]
 * @returns {object}
 */
function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			if (body instanceof Error) throw body
			return body
		},
		async text() {
			if (body instanceof Error) throw body
			return JSON.stringify(body)
		},
		async arrayBuffer() {
			return new ArrayBuffer(0)
		},
	}
}

/**
 * @param {Uint8Array} bytes
 * @param {number} [status]
 * @returns {object}
 */
function bytesResponse(bytes, status = 200) {
	const payload = Buffer.from(bytes)
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			throw new Error('不是 JSON')
		},
		async text() {
			throw new Error('不是文字')
		},
		async arrayBuffer() {
			return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
		},
	}
}

/**
 * @param {Record<string, object | ((url: string, init: object) => object)>} routes
 * @returns {{ fetch: Function, calls: Array<{ url: string, init: object }> }}
 */
function fakeFetch(routes) {
	const calls = []
	const fetch = async (url, init) => {
		calls.push({ url, init })
		const handler = routes[url]
		if (handler === undefined) throw new Error(`測試沒有安排 ${url}`)
		return typeof handler === 'function' ? handler(url, init) : handler
	}
	return { fetch, calls }
}

/**
 * @param {Record<string, object | Function>} routes
 * @param {object} [options]
 */
function clientFor(routes, options = {}) {
	const fake = fakeFetch(routes)
	const client = createRegistryClient({ registry: REGISTRY, fetch: fake.fetch, ...options })
	return { client, calls: fake.calls }
}

const PACKUMENT = {
	name: 'demo-pkg',
	'dist-tags': { latest: '2.0.0', next: '3.0.0-rc.1' },
	versions: {
		'1.0.0': {
			name: 'demo-pkg',
			version: '1.0.0',
			dist: { tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-1.0.0.tgz`, integrity: 'sha512-aaa', shasum: 'aaa' },
			gitHead: 'aaaa1111',
		},
		'1.0.1': {
			name: 'demo-pkg',
			version: '1.0.1',
			dist: { tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-1.0.1.tgz`, integrity: 'sha512-bbb', shasum: 'bbb' },
			gitHead: 'bbbb1111',
		},
		'1.5.0': {
			name: 'demo-pkg',
			version: '1.5.0',
			dist: { tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-1.5.0.tgz`, integrity: 'sha512-eee', shasum: 'eee' },
			gitHead: 'eeee1111',
		},
		'2.0.0': {
			name: 'demo-pkg',
			version: '2.0.0',
			dist: { tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-2.0.0.tgz`, integrity: 'sha512-ccc', shasum: 'ccc' },
			gitHead: 'cccc2222',
			engines: { dsh: '>=0.2.0 <0.3.0' },
			deprecated: '改用 3.x',
		},
		'3.0.0-rc.1': {
			name: 'demo-pkg',
			version: '3.0.0-rc.1',
			dist: { tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-3.0.0-rc.1.tgz`, integrity: 'sha512-ddd', shasum: 'ddd' },
			gitHead: 'dddd3333',
		},
	},
	time: {
		created: '2020-01-01T00:00:00.000Z',
		modified: '2023-01-01T00:00:00.000Z',
		'1.0.0': '2020-01-02T00:00:00.000Z',
		'1.0.1': '2020-02-02T00:00:00.000Z',
		'1.5.0': '2021-06-01T00:00:00.000Z',
		'2.0.0': '2022-03-04T05:06:07.000Z',
		'3.0.0-rc.1': '2023-01-01T00:00:00.000Z',
	},
}

/**
 * @returns {Record<string, object>}
 */
function routes() {
	return { [PACKAGE_URL]: jsonResponse(PACKUMENT) }
}

test('packument 用注入的 fetch 抓原始 JSON，並帶上 AbortSignal', async () => {
	const { client, calls } = clientFor(routes())
	const doc = await client.packument('demo-pkg')
	assert.equal(doc.name, 'demo-pkg')
	assert.equal(doc['dist-tags'].latest, '2.0.0')
	assert.equal(calls.length, 1)
	assert.equal(calls[0].url, PACKAGE_URL)
	assert.ok(calls[0].init.signal instanceof AbortSignal)
	assert.equal(calls[0].init.signal.aborted, false)
})

test('latest 取 dist-tags.latest，附上 manifest、dist 與發佈資訊', async () => {
	const { client } = clientFor(routes())
	const doc = await client.versionDoc('demo-pkg', 'latest')
	assert.equal(doc.version, '2.0.0')
	assert.equal(doc.requestedRange, 'latest')
	assert.deepEqual(doc.manifest, PACKUMENT.versions['2.0.0'])
	assert.deepEqual(doc.dist, {
		tarball: `${REGISTRY}/demo-pkg/-/demo-pkg-2.0.0.tgz`,
		integrity: 'sha512-ccc',
		shasum: 'ccc',
	})
	assert.equal(doc.gitHead, 'cccc2222')
	assert.equal(doc.publishTime, '2022-03-04T05:06:07.000Z')
	assert.equal(doc.deprecated, '改用 3.x')
})

test('沒給 range 等同 latest', async () => {
	const { client } = clientFor(routes())
	assert.equal((await client.versionDoc('demo-pkg')).version, '2.0.0')
})

test('範圍內挑最高版，不是 dist-tags.latest', async () => {
	const { client } = clientFor(routes())
	assert.equal((await client.versionDoc('demo-pkg', '^1.0.0')).version, '1.5.0')
	assert.equal((await client.versionDoc('demo-pkg', '>=1.0.0 <1.5.0')).version, '1.0.1')
	assert.equal((await client.versionDoc('demo-pkg', '1.0.1')).version, '1.0.1')
})

test('prerelease 參與範圍判定', async () => {
	const { client } = clientFor(routes())
	const doc = await client.versionDoc('demo-pkg', '>=3.0.0-rc.1')
	assert.equal(doc.version, '3.0.0-rc.1')
	assert.equal(doc.requestedRange, '>=3.0.0-rc.1')
})

test('找不到符合版本是 NO_MATCHING_VERSION', async () => {
	const { client } = clientFor(routes())
	await assert.rejects(client.versionDoc('demo-pkg', '^9'), (error) => {
		assert.ok(error instanceof RegistryError)
		assert.equal(error.code, 'NO_MATCHING_VERSION')
		assert.match(error.message, /\^9/)
		assert.equal(error.url, PACKAGE_URL)
		return true
	})
})

test('404 是 NOT_FOUND，壞 JSON 是 INVALID_JSON，連不上與 5xx 都是 NETWORK', async () => {
	const missing = clientFor({ [PACKAGE_URL]: jsonResponse({}, 404) }).client
	await assert.rejects(missing.packument('demo-pkg'), (error) => {
		assert.equal(error.code, 'NOT_FOUND')
		assert.equal(error.status, 404)
		assert.equal(error.url, PACKAGE_URL)
		return true
	})

	const broken = clientFor({ [PACKAGE_URL]: jsonResponse(new Error('Unexpected token')) }).client
	await assert.rejects(broken.packument('demo-pkg'), (error) => {
		assert.equal(error.code, 'INVALID_JSON')
		return true
	})

	const offline = clientFor({
		[PACKAGE_URL]: () => {
			throw new TypeError('fetch failed')
		},
	}).client
	await assert.rejects(offline.packument('demo-pkg'), (error) => {
		assert.equal(error.code, 'NETWORK')
		assert.match(error.message, /fetch failed/)
		assert.equal(error.url, PACKAGE_URL)
		return true
	})

	const down = clientFor({ [PACKAGE_URL]: jsonResponse({}, 503) }).client
	await assert.rejects(down.packument('demo-pkg'), (error) => {
		assert.equal(error.code, 'NETWORK')
		assert.equal(error.status, 503)
		return true
	})
})

test('同一次稽核內 packument 只抓一次', async () => {
	const { client, calls } = clientFor(routes())
	await client.versionDoc('demo-pkg', 'latest')
	await client.packument('demo-pkg')
	assert.equal(calls.length, 1)
})

test('scoped 名稱只把斜線編成 %2F', async () => {
	const scoped = {
		name: '@scope/name',
		'dist-tags': { latest: '1.0.0' },
		versions: { '1.0.0': { name: '@scope/name', version: '1.0.0', dist: {} } },
		time: { '1.0.0': '2024-01-01T00:00:00.000Z' },
	}
	const { client, calls } = clientFor({ [`${REGISTRY}/@scope%2Fname`]: jsonResponse(scoped) })
	const doc = await client.versionDoc('@scope/name', 'latest')
	assert.equal(doc.version, '1.0.0')
	assert.equal(doc.publishTime, '2024-01-01T00:00:00.000Z')
	assert.equal(calls[0].url, `${REGISTRY}/@scope%2Fname`)
})

test('沒給 registry 時打 npmjs；timeoutMs 為 0 時不掛 signal', async () => {
	const npmjs = fakeFetch({ 'https://registry.npmjs.org/demo-pkg': jsonResponse(PACKUMENT) })
	const client = createRegistryClient({ fetch: npmjs.fetch })
	await client.packument('demo-pkg')
	assert.equal(npmjs.calls[0].url, 'https://registry.npmjs.org/demo-pkg')

	const { client: noTimeout, calls } = clientFor(routes(), { timeoutMs: 0 })
	await noTimeout.packument('demo-pkg')
	assert.equal(calls[0].init.signal, undefined)
})

test('注入的 fetch 不是函式時立刻報錯', () => {
	assert.throws(() => createRegistryClient({ fetch: 'nope' }), TypeError)
})

test('tarball 回傳 Buffer', async () => {
	const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02])
	const url = `${REGISTRY}/demo-pkg/-/demo-pkg-2.0.0.tgz`
	const { client } = clientFor({ [url]: bytesResponse(bytes) })
	const result = await client.tarball(url)
	assert.ok(Buffer.isBuffer(result))
	assert.deepEqual(result, bytes)
})

test('tarball 404 是 NOT_FOUND，5xx 是 NETWORK', async () => {
	const url = `${REGISTRY}/demo-pkg/-/demo-pkg-2.0.0.tgz`
	const missing = clientFor({ [url]: bytesResponse(Buffer.alloc(0), 404) }).client
	await assert.rejects(missing.tarball(url), (error) => error.code === 'NOT_FOUND' && error.status === 404)

	const down = clientFor({ [url]: bytesResponse(Buffer.alloc(0), 500) }).client
	await assert.rejects(down.tarball(url), (error) => error.code === 'NETWORK' && error.status === 500)
})

test('attestations：404 不算錯', async () => {
	const { client } = clientFor({ [ATTESTATION_URL]: jsonResponse({}, 404) })
	assert.deepEqual(await client.attestations('demo-pkg', '2.0.0'), {
		found: false,
		status: 404,
		url: ATTESTATION_URL,
		predicates: [],
		raw: undefined,
	})
})

test('attestations：有內容時回報 predicate 型別', async () => {
	const body = {
		attestations: [
			{ predicateType: 'https://slsa.dev/provenance/v1' },
			{ predicateType: 'https://slsa.dev/provenance/v0.2' },
			{ predicateType: 'https://slsa.dev/provenance/v1' },
			{},
		],
	}
	const { client } = clientFor({ [ATTESTATION_URL]: jsonResponse(body) })
	const result = await client.attestations('demo-pkg', '2.0.0')
	assert.equal(result.found, true)
	assert.equal(result.status, 200)
	assert.deepEqual(result.predicates, ['https://slsa.dev/provenance/v1', 'https://slsa.dev/provenance/v0.2'])
	assert.equal(result.raw, body)
})

test('attestations：scoped 名稱同樣編碼', async () => {
	const url = `${REGISTRY}/-/npm/v1/attestations/@scope%2Fname@1.0.0`
	const { client, calls } = clientFor({ [url]: jsonResponse({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }] }) })
	const result = await client.attestations('@scope/name', '1.0.0')
	assert.equal(result.found, true)
	assert.equal(calls[0].url, url)
})

test('attestations：5xx、壞 JSON 與連線失敗都只回 status，不丟錯', async () => {
	const down = clientFor({ [ATTESTATION_URL]: jsonResponse({}, 500) }).client
	assert.deepEqual(await down.attestations('demo-pkg', '2.0.0'), {
		found: false,
		status: 500,
		url: ATTESTATION_URL,
		predicates: [],
		raw: undefined,
	})

	const broken = clientFor({ [ATTESTATION_URL]: jsonResponse(new Error('壞掉')) }).client
	assert.equal((await broken.attestations('demo-pkg', '2.0.0')).found, false)

	const offline = clientFor({
		[ATTESTATION_URL]: () => {
			throw new Error('offline')
		},
	}).client
	const result = await offline.attestations('demo-pkg', '2.0.0')
	assert.equal(result.found, false)
	assert.equal(result.status, 0)
	assert.equal(result.raw, undefined)
})
