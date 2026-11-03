/**
 * Read a published npm tarball without unpacking it to disk.
 *
 * A registry tarball is a gzip stream around a ustar archive whose paths start
 * with `package/`. The audit only asks two questions — what is in here, and what
 * is in one named file — so this module decodes just enough of the format by
 * hand: 512-byte headers, the octal size field, the type flag, the prefix field,
 * and the GNU (`L`) and PAX (`x`) records that carry names longer than 100 bytes.
 *
 * Paths are normalised on the way out: a leading `./` and the `package/` prefix
 * are removed, so `readTarFile(archive, 'package.json')` works on any tarball.
 * Malformed input throws `Error`; the caller turns that into
 * `audit/tarball-unreadable`.
 *
 * @module dsh-plugin-devkit/tar
 */

import { gunzipSync } from 'node:zlib'

const BLOCK_SIZE = 512
const NAME_OFFSET = 0
const NAME_LENGTH = 100
const SIZE_OFFSET = 124
const SIZE_LENGTH = 12
const TYPE_OFFSET = 156
const MAGIC_OFFSET = 257
const PREFIX_OFFSET = 345
const PREFIX_LENGTH = 155
const PACKAGE_PREFIX = 'package/'
/** Header types whose body describes the entry that follows. */
const METADATA_TYPES = new Set(['L', 'K', 'x', 'g'])

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Read a NUL-terminated UTF-8 field.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function readText(bytes) {
	const end = bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)
	return bytes.toString('utf8', 0, end)
}

/**
 * `./` and `package/` are archive packaging, not part of the path the audit
 * talks about. Repeatedly, because both can appear in either order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizePath(value) {
	let path = String(value ?? '').replace(/\\/g, '/')
	let stripped = true
	while (stripped) {
		stripped = false
		if (path.startsWith('./')) {
			path = path.slice(2)
			stripped = true
			continue
		}
		if (path.startsWith(PACKAGE_PREFIX)) {
			path = path.slice(PACKAGE_PREFIX.length)
			stripped = true
		}
	}
	return path.replace(/\/+$/, '')
}

/**
 * @param {Buffer} block
 * @returns {boolean}
 */
function isZeroBlock(block) {
	for (const byte of block) {
		if (byte !== 0) return false
	}
	return true
}

/**
 * @param {Buffer} buffer
 * @param {number} from
 * @returns {boolean}
 */
function isZeroRange(buffer, from) {
	for (let index = from; index < buffer.length; index += 1) {
		if (buffer[index] !== 0) return false
	}
	return true
}

/**
 * Size field: octal text, or GNU base-256 when the high bit is set.
 *
 * @param {Buffer} header
 * @returns {number}
 */
function readSize(header) {
	const field = header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH)
	if ((field[0] & 0x80) !== 0) {
		let value = field[0] & 0x7f
		for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]
		if (!Number.isSafeInteger(value)) throw new Error('tar: 檔案大小超出可處理範圍')
		return value
	}
	const text = readText(field).trim()
	if (text === '') return 0
	if (!/^[0-7]+$/.test(text)) throw new Error(`tar: 無法解析的檔案大小 ${JSON.stringify(text)}`)
	return Number.parseInt(text, 8)
}

/**
 * PAX body: `<length> <key>=<value>\n` records, lengths counted in bytes.
 *
 * @param {Buffer} data
 * @returns {Map<string, string>}
 */
function parsePax(data) {
	const updates = new Map()
	let offset = 0
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset)
		if (space < 0) break
		const length = Number.parseInt(data.toString('utf8', offset, space).trim(), 10)
		if (!Number.isInteger(length) || length <= 0) break
		const end = offset + length
		if (end > data.length) break
		const record = data.toString('utf8', space + 1, end).replace(/\n$/, '')
		const separator = record.indexOf('=')
		if (separator > 0) updates.set(record.slice(0, separator), record.slice(separator + 1))
		offset = end
	}
	return updates
}

/**
 * @param {string} typeflag
 * @returns {'file' | 'dir' | 'other'}
 */
function typeOf(typeflag) {
	if (typeflag === '5') return 'dir'
	if (typeflag === '0' || typeflag === '7') return 'file'
	return 'other'
}

/**
 * Name from the header, joined with the ustar `prefix` field when present.
 *
 * @param {Buffer} header
 * @returns {string}
 */
function headerPath(header) {
	const name = readText(header.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH))
	const magic = header.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 6).toString('latin1')
	if (!magic.startsWith('ustar')) return name
	const prefix = readText(header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH))
	return prefix === '' ? name : `${prefix}/${name}`
}

/**
 * The data length to advance by: metadata records use their own header size,
 * while a regular entry may have been given one by a PAX `size` record.
 *
 * @param {Buffer} header
 * @param {string} typeflag
 * @param {Map<string, string>} pendingPax
 * @returns {number}
 */
function entrySize(header, typeflag, pendingPax) {
	const headerSize = readSize(header)
	if (METADATA_TYPES.has(typeflag)) return headerSize
	const paxSize = pendingPax.get('size')
	if (paxSize !== undefined && /^\d+$/.test(paxSize)) return Number(paxSize)
	return headerSize
}

/**
 * Walk the archive once.
 *
 * @param {Uint8Array} gzipBuffer
 * @returns {{ buffer: Buffer, entries: Array<{ path: string, size: number, type: 'file' | 'dir' | 'other', start: number }> }}
 */
function unpack(gzipBuffer) {
	if (!(gzipBuffer instanceof Uint8Array)) throw new Error('tar: 需要 gzip 過的 Uint8Array 或 Buffer')
	let buffer
	try {
		buffer = gunzipSync(gzipBuffer)
	} catch (error) {
		throw new Error(`tar: gzip 解壓失敗（${messageOf(error)}）`)
	}

	/** @type {Array<{ path: string, size: number, type: 'file' | 'dir' | 'other', start: number }>} */
	const entries = []
	let offset = 0
	/** @type {string | undefined} */
	let pendingName
	/** @type {Map<string, string>} */
	let pendingPax = new Map()

	while (offset + BLOCK_SIZE <= buffer.length) {
		const header = buffer.subarray(offset, offset + BLOCK_SIZE)
		if (isZeroBlock(header)) break

		const typeflag = header[TYPE_OFFSET] === 0 || header[TYPE_OFFSET] === 0x20 ? '0' : String.fromCharCode(header[TYPE_OFFSET])
		const size = entrySize(header, typeflag, pendingPax)
		const start = offset + BLOCK_SIZE
		const end = start + size
		if (end > buffer.length) {
			throw new Error(`tar: ${entries.length + 1} 號項目的內容被截斷（需要 ${size} bytes，只剩 ${buffer.length - start}）`)
		}
		const data = buffer.subarray(start, end)
		offset = start + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE

		if (typeflag === 'L') {
			pendingName = readText(data)
			continue
		}
		if (typeflag === 'K') continue
		if (typeflag === 'x') {
			pendingPax = parsePax(data)
			continue
		}
		if (typeflag === 'g') continue

		const rawPath = pendingName ?? pendingPax.get('path') ?? headerPath(header)
		pendingName = undefined
		pendingPax = new Map()
		const path = normalizePath(rawPath)
		if (path === '') continue
		entries.push({ path, size, type: typeOf(typeflag), start })
	}

	if (offset < buffer.length && !isZeroRange(buffer, offset)) {
		throw new Error('tar: 結尾有多餘的非零資料')
	}
	return { buffer, entries }
}

/**
 * Every path in a tarball, normalized and in archive order.
 *
 * @param {Uint8Array} gzipBuffer
 * @returns {Array<{ path: string, size: number, type: 'file' | 'dir' | 'other' }>}
 */
export function listTarEntries(gzipBuffer) {
	const { entries } = unpack(gzipBuffer)
	return entries.map((entry) => ({ path: entry.path, size: entry.size, type: entry.type }))
}

/**
 * One file's bytes, or `undefined` when the archive has no such file.
 *
 * @param {Uint8Array} gzipBuffer
 * @param {string} path path as it appears inside the package, with or without `package/`
 * @returns {Uint8Array | undefined}
 */
export function readTarFile(gzipBuffer, path) {
	const wanted = normalizePath(path)
	if (wanted === '') return undefined
	const { buffer, entries } = unpack(gzipBuffer)
	const entry = entries.find((candidate) => candidate.type === 'file' && candidate.path === wanted)
	if (entry === undefined) return undefined
	return new Uint8Array(buffer.subarray(entry.start, entry.start + entry.size))
}
