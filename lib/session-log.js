/**
 * Read a DSH session log (`session.v4.jsonl.zstd`) back into events, so a bug
 * seen in a real session can become a test fixture with the host's real shapes.
 *
 * The file is many zstd frames back to back. Node's `zstdDecompressSync` (and
 * the stream) stop after the first frame, and return whatever they got, without
 * an error, for a truncated or garbage frame. So the frames are measured from
 * their headers (RFC 8878 §3.1) instead of cut at the magic, which can also
 * occur inside compressed bytes.
 *
 * @module dsh-plugin-devkit/session-log
 */

import { zstdDecompressSync } from 'node:zlib'

const FRAME_MAGIC = 0xfd2fb528
const FCS_BYTES = [0, 2, 4, 8]
const DICT_BYTES = [0, 1, 2, 4]

/**
 * Length in bytes of the frame starting at `at`, or 0 for a skippable frame's
 * caller to skip; throws when the frame runs past the end of the buffer.
 *
 * @param {Buffer} buffer
 * @param {number} at
 * @returns {{ size: number, skippable: boolean }}
 */
function measureFrame(buffer, at) {
	const need = (end) => {
		if (end > buffer.length) throw new Error(`位移 ${at} 的 frame 被截斷（需要 ${end} 位元組，檔案只有 ${buffer.length}）`)
	}
	need(at + 8)
	const magic = buffer.readUInt32LE(at)
	if ((magic & 0xfffffff0) === 0x184d2a50) {
		const size = 8 + buffer.readUInt32LE(at + 4)
		need(at + size)
		return { size, skippable: true }
	}
	if (magic !== FRAME_MAGIC) throw new Error(`位移 ${at} 不是 zstd frame（magic 0x${magic.toString(16)}）`)
	const descriptor = buffer[at + 4]
	const singleSegment = (descriptor >> 5) & 1
	const fcsFlag = descriptor >> 6
	let cursor = at + 5 + (singleSegment ? 0 : 1) + DICT_BYTES[descriptor & 3] + (fcsFlag === 0 ? singleSegment : FCS_BYTES[fcsFlag])
	for (let last = 0; !last; ) {
		need(cursor + 3)
		const header = buffer.readUIntLE(cursor, 3)
		last = header & 1
		const type = (header >> 1) & 3
		if (type === 3) throw new Error(`位移 ${cursor} 的 block 型別保留未用：檔案損壞`)
		cursor += 3 + (type === 1 ? 1 : header >> 3) // RLE blocks store one byte
	}
	cursor += (descriptor >> 2) & 1 ? 4 : 0 // content checksum
	need(cursor)
	return { size: cursor - at, skippable: false }
}

/**
 * @param {Buffer} buffer the raw `.jsonl.zstd` file
 * @returns {Array<Record<string, any>>} every JSON line, header line included
 */
export function readSessionLog(buffer) {
	const lines = []
	for (let at = 0; at < buffer.length; ) {
		const { size, skippable } = measureFrame(buffer, at)
		if (!skippable) {
			const text = zstdDecompressSync(buffer.subarray(at, at + size)).toString('utf8')
			for (const line of text.split('\n')) {
				if (line.trim() === '') continue
				try {
					lines.push(JSON.parse(line))
				} catch (error) {
					throw new Error(`位移 ${at} 的 frame 內容不是 JSON（frame 可能損壞）：${error.message}`)
				}
			}
		}
		at += size
	}
	return lines
}

// Keys whose values are enum tags or generated ids in real session logs
// (tallied over six logs, 2026-11-09). Every other string is redacted, so a
// new content field is hidden by default instead of leaking.
// ponytail: a hand-kept allowlist — add a key when a fixture needs its value.
const KEEP_KEYS = new Set([
	'type', 'kind', 'role', 'name', 'toolName', 'model', 'provider', 'api', 'blockType', 'stopReason',
	'status', 'cause', 'reason', 'form', 'target', 'lang', 'mode', 'action', 'shape', 'code', 'policy',
	'source', 'preset', 'phase', 'outcome', 'operation', 'reasoningEffort', 'required', 'enum',
	'id', 'callId', 'toolCallId', 'rootCallId', 'jobId', 'responseId', 'commandId'
])
// Keys whose string value is a JSON document the host itself serialised (tool
// arguments). Only these are parsed: other content that happens to be JSON is
// prose or file text and stays fully redacted.
const JSON_KEYS = new Set(['arguments', 'args'])
// Even an allowlisted value must look like an identifier, or it is redacted too.
const IDENTIFIER = /^[A-Za-z0-9_.:\/-]{0,64}$/

/**
 * Replace strings with `<redacted>` unless their key is allowlisted and the
 * value looks like an identifier. Keys, numbers, booleans and nesting stay, and
 * the JSON string in tool arguments (`tool/call.data.arguments`) keeps its
 * keys and numbers, loses every string, and stays parseable, so the fixture
 * keeps the host's shape without the content.
 *
 * @template T
 * @param {T} value
 * @param {string} [key] the key this value sits under; array items inherit it
 * @param {boolean} [opaque] inside tool arguments: redact every string leaf
 * @returns {T}
 */
export function redact(value, key, opaque = false) {
	if (typeof value === 'string') {
		if (!opaque && JSON_KEYS.has(key ?? '') && /^\s*[[{]/.test(value)) {
			try {
				// Tool arguments are third-party shapes: the host-field allowlist
				// does not apply inside them, so every string leaf goes.
				return /** @type {any} */ (JSON.stringify(redact(JSON.parse(value), undefined, true)))
			} catch {
				// not JSON after all: fall through
			}
		}
		return /** @type {any} */ (!opaque && KEEP_KEYS.has(key ?? '') && IDENTIFIER.test(value) ? value : '<redacted>')
	}
	if (Array.isArray(value)) return /** @type {any} */ (value.map((item) => redact(item, key, opaque)))
	if (value !== null && typeof value === 'object') {
		return /** @type {any} */ (
			Object.fromEntries(Object.entries(value).map(([inner, item]) => [inner, redact(item, inner, opaque)]))
		)
	}
	return value
}

/**
 * Keep the events a fixture needs: drop the header line, filter by type and
 * seq range (inclusive), redact unless asked not to.
 *
 * @param {Array<Record<string, any>>} lines output of readSessionLog
 * @param {{ types?: string[], from?: number, to?: number, raw?: boolean }} [options]
 */
export function selectEvents(lines, { types, from, to, raw = false } = {}) {
	const picked = lines.filter(
		(line) =>
			typeof line.seq === 'number' &&
			(types === undefined || types.includes(line.type)) &&
			(from === undefined || line.seq >= from) &&
			(to === undefined || line.seq <= to)
	)
	return raw ? picked : picked.map((event) => redact(event))
}
