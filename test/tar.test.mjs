import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { listTarEntries, readTarFile } from '../lib/tar.js'

const BLOCK = 512
const MANIFEST = JSON.stringify({ name: 'demo-pkg', version: '1.0.0' })

/**
 * Write one octal field the way tar spells it: digits, zero padded, NUL ended.
 *
 * @param {number} value
 * @param {number} width
 * @returns {string}
 */
function octal(value, width) {
	return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/**
 * Build one ustar header block, checksum included.
 *
 * @param {{ name: string, size?: number, type?: string, prefix?: string, linkname?: string }} fields
 * @returns {Buffer}
 */
function header({ name, size = 0, type = '0', prefix = '', linkname = '' }) {
	const block = Buffer.alloc(BLOCK)
	block.write(name.slice(0, 100), 0, 100, 'utf8')
	block.write(octal(0o644, 8), 100, 8, 'ascii')
	block.write(octal(0, 8), 108, 8, 'ascii')
	block.write(octal(0, 8), 116, 8, 'ascii')
	block.write(octal(size, 12), 124, 12, 'ascii')
	block.write(octal(0, 12), 136, 12, 'ascii')
	block.fill(0x20, 148, 156)
	block.write(type.slice(0, 1), 156, 1, 'ascii')
	block.write(linkname.slice(0, 100), 157, 100, 'utf8')
	block.write('ustar\0', 257, 6, 'ascii')
	block.write('00', 263, 2, 'ascii')
	if (prefix !== '') block.write(prefix.slice(0, 155), 345, 155, 'utf8')
	let sum = 0
	for (const byte of block) sum += byte
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
	return block
}

/**
 * @param {Buffer} body
 * @returns {Buffer}
 */
function pad(body) {
	const remainder = body.length % BLOCK
	return remainder === 0 ? body : Buffer.concat([body, Buffer.alloc(BLOCK - remainder)])
}

/**
 * @param {string} name
 * @param {string} content
 * @param {string} [type]
 * @returns {Buffer}
 */
function entry(name, content, type = '0') {
	const body = Buffer.from(content)
	return Buffer.concat([header({ name, size: body.length, type }), pad(body)])
}

/**
 * One PAX extended-header record: `<length> <key>=<value>\n`, length in bytes.
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function paxRecord(key, value) {
	const body = ` ${key}=${value}\n`
	let length = Buffer.byteLength(body) + 1
	for (;;) {
		const candidate = `${length}${body}`
		const size = Buffer.byteLength(candidate)
		if (size === length) return candidate
		length = size
	}
}

const MAIN = Buffer.concat([
	entry('package/package.json', MANIFEST),
	entry('./package/./lib/nested.txt', 'nested'),
	entry('package/README.md', '# demo\n'),
	header({ name: 'package/lib/', size: 0, type: '5' }),
	header({ name: 'package/link', size: 0, type: '2', linkname: 'lib/nested.txt' }),
	Buffer.alloc(BLOCK * 2),
])

const LONG_PATH = `package/${'a'.repeat(120)}/module.js`
const LONG_ARCHIVE = Buffer.concat([
	header({ name: '././@LongLink', size: Buffer.byteLength(LONG_PATH) + 1, type: 'L' }),
	pad(Buffer.from(`${LONG_PATH}\0`, 'utf8')),
	header({ name: 'module.js', size: 5, type: '0' }),
	pad(Buffer.from('hello')),
	entry('package/after.js', 'after'),
	Buffer.alloc(BLOCK * 2),
])

const PAX_PATH = `package/${'b'.repeat(60)}/pax.js`
const PAX_BODY = Buffer.from([paxRecord('path', PAX_PATH), paxRecord('mtime', '1700000000.5')].join(''), 'utf8')
const GLOBAL_BODY = Buffer.from(paxRecord('mtime', '1700000000'), 'utf8')
const PAX_ARCHIVE = Buffer.concat([
	header({ name: 'pax_global_header', size: GLOBAL_BODY.length, type: 'g' }),
	pad(GLOBAL_BODY),
	header({ name: 'PaxHeader', size: PAX_BODY.length, type: 'x' }),
	pad(PAX_BODY),
	header({ name: 'pax.js', size: 4, type: '0' }),
	pad(Buffer.from('pax\n')),
	Buffer.alloc(BLOCK * 2),
])

test('列出項目：去掉 ./ 與 package/ 前綴，型別與大小正確', () => {
	const entries = listTarEntries(gzipSync(MAIN))
	assert.deepEqual(
		entries.map((item) => item.path),
		['package.json', 'lib/nested.txt', 'README.md', 'lib', 'link']
	)
	assert.deepEqual(
		entries.map((item) => item.type),
		['file', 'file', 'file', 'dir', 'other']
	)
	assert.equal(entries[0].size, Buffer.byteLength(MANIFEST))
	assert.equal(entries[1].size, 6)
	assert.equal(entries[3].size, 0)
	assert.equal(entries[4].size, 0)
})

test('readTarFile 取單檔內容，找不到回 undefined', () => {
	const archive = gzipSync(MAIN)
	assert.deepEqual(Buffer.from(readTarFile(archive, 'package.json')), Buffer.from(MANIFEST))
	assert.deepEqual(Buffer.from(readTarFile(archive, './package/package.json')), Buffer.from(MANIFEST))
	assert.deepEqual(Buffer.from(readTarFile(archive, 'lib/nested.txt')), Buffer.from('nested'))
	assert.equal(readTarFile(archive, 'nope.js'), undefined)
	assert.equal(readTarFile(archive, 'lib'), undefined)
	assert.equal(readTarFile(archive, ''), undefined)
})

test('GNU longname（L）套用到下一個項目，且不影響再下一個', () => {
	const archive = gzipSync(LONG_ARCHIVE)
	const entries = listTarEntries(archive)
	assert.deepEqual(
		entries.map((item) => item.path),
		[`${'a'.repeat(120)}/module.js`, 'after.js']
	)
	assert.equal(entries[0].size, 5)
	assert.deepEqual(Buffer.from(readTarFile(archive, LONG_PATH)), Buffer.from('hello'))
	assert.deepEqual(Buffer.from(readTarFile(archive, 'after.js')), Buffer.from('after'))
})

test('PAX（x）的 path 覆蓋 header 名稱，global（g）被跳過', () => {
	const archive = gzipSync(PAX_ARCHIVE)
	const entries = listTarEntries(archive)
	assert.deepEqual(
		entries.map((item) => item.path),
		[`${'b'.repeat(60)}/pax.js`]
	)
	assert.equal(entries[0].size, 4)
	assert.deepEqual(Buffer.from(readTarFile(archive, PAX_PATH)), Buffer.from('pax\n'))
	assert.deepEqual(Buffer.from(readTarFile(archive, `${'b'.repeat(60)}/pax.js`)), Buffer.from('pax\n'))
})

test('空 archive 回空陣列', () => {
	assert.deepEqual(listTarEntries(gzipSync(Buffer.alloc(BLOCK * 2))), [])
})

test('壞掉的 gzip、截斷的 tar、非 buffer 都丟 Error', () => {
	assert.throws(() => listTarEntries(Buffer.from('not gzip at all')), /gzip/)
	assert.throws(() => listTarEntries('nope'), /Uint8Array/)
	const truncated = Buffer.concat([header({ name: 'package/big.bin', size: 4096 }), Buffer.alloc(BLOCK)])
	assert.throws(() => listTarEntries(gzipSync(truncated)), /截斷/)
})
