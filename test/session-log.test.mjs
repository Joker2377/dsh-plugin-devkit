import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { constants, zstdCompressSync } from 'node:zlib'

import { readSessionLog, redact, selectEvents } from '../lib/session-log.js'
import { parseEventsArgs } from '../scripts/cli.mjs'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const jsonl = (lines) => Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
const frame = (...lines) => zstdCompressSync(jsonl(lines))
// The host writes frames with a checksum, a window descriptor and no content
// size (descriptor 0x04); Node's default (0x20) exercises neither branch.
const hostFrame = (...lines) =>
	zstdCompressSync(jsonl(lines), {
		params: { [constants.ZSTD_c_checksumFlag]: 1, [constants.ZSTD_c_contentSizeFlag]: 0 }
	})

const header = { type: 'session', version: 4, id: 'session-1' }
const start = { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } }
const call = { type: 'tool/call', seq: 2, time: 11, data: { turn: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"ls C:\\\\x"}' } }
const end = { type: 'turn/end', seq: 3, time: 12, data: { turn: 1, reason: { kind: 'completed' } } }

test('readSessionLog：多個 frame 依序讀回所有行', () => {
	const lines = readSessionLog(Buffer.concat([frame(header, start), frame(call), frame(end)]))
	assert.deepEqual(lines, [header, start, call, end])
})

test('readSessionLog：host 的 frame 格式（有 checksum、無 content size）', () => {
	const first = hostFrame(header, start)
	assert.equal(first[4], 0x04, '前提：frame header descriptor 與 host 相同')
	assert.deepEqual(readSessionLog(Buffer.concat([first, hostFrame(call), hostFrame(end)])), [header, start, call, end])
})

test('readSessionLog：host 格式只截掉 checksum 的 1 到 4 位元組也報截斷', () => {
	const whole = hostFrame(end)
	for (const cut of [1, 2, 3, 4]) {
		assert.throws(() => readSessionLog(Buffer.concat([hostFrame(start), whole.subarray(0, whole.length - cut)])), /截斷/, `少 ${cut} 位元組`)
	}
})

test('readSessionLog：壓縮內容裡出現 frame magic 時不會從中間切斷', () => {
	// Incompressible bytes end up in a raw block, so the magic planted in them
	// shows up verbatim inside the compressed frame.
	const noise = [...randomBytes(4096)].filter((byte) => byte >= 0x20 && byte !== 0x22 && byte !== 0x5c)
	const payload = Buffer.concat([Buffer.from('{"type":"x","seq":1,"blob":"'), Buffer.from(noise), MAGIC, Buffer.from(noise), Buffer.from('"}\n')])
	const tricky = zstdCompressSync(payload)
	assert.ok(tricky.indexOf(MAGIC, 1) > 0, '前提：magic 要出現在 frame 內部')
	const lines = readSessionLog(Buffer.concat([tricky, frame(end)]))
	assert.deepEqual(lines.map((line) => line.type), ['x', 'turn/end'])
})

test('readSessionLog：不是 zstd 檔就明說', () => {
	assert.throws(() => readSessionLog(Buffer.from('{"type":"session"}\n')), /不是 zstd frame/)
})

// Node returns an empty result for these without an error, so the reader must catch them itself.
test('readSessionLog：最後一個 frame 被截斷就報錯，不默默少事件', () => {
	const whole = frame(end)
	for (const cut of [1, 4, whole.length - 5]) {
		assert.throws(() => readSessionLog(Buffer.concat([frame(start), whole.subarray(0, whole.length - cut)])), /截斷/, `少 ${cut} 位元組`)
	}
})

test('readSessionLog：跳過 skippable frame', () => {
	const skippable = Buffer.alloc(8 + 3)
	skippable.writeUInt32LE(0x184d2a50, 0)
	skippable.writeUInt32LE(3, 4)
	assert.deepEqual(readSessionLog(Buffer.concat([frame(start), skippable, frame(end)])), [start, end])
})

test('redact：白名單鍵的識別字保留，其他字串一律遮掉', () => {
	const message = {
		type: 'assistant/message',
		seq: 4,
		data: {
			role: 'assistant',
			stopReason: 'stop',
			stream: [{ blockType: 'text', texts: ['The', 'goal', 'ghp_abc123'] }],
			meta: { url: 'https://example.com/a', path: 'lib/index.js', lines: [{ text: 'secret=1' }] }
		}
	}
	assert.deepEqual(redact(message), {
		type: 'assistant/message',
		seq: 4,
		data: {
			role: 'assistant',
			stopReason: 'stop',
			stream: [{ blockType: 'text', texts: ['<redacted>', '<redacted>', '<redacted>'] }],
			meta: { url: '<redacted>', path: '<redacted>', lines: [{ text: '<redacted>' }] }
		}
	})
	assert.deepEqual(redact({ kind: '有空白 的 內文', ok: true, n: null }), { kind: '<redacted>', ok: true, n: null })
	// Only tool arguments are parsed as JSON; JSON-looking prose stays opaque.
	assert.deepEqual(redact({ texts: ['[13]'], text: '{"goal":{"id":"g-1"}}' }), { texts: ['<redacted>'], text: '<redacted>' })
})

test('redact：JSON 字串遮蔽內容後仍可解析，鍵都還在', () => {
	const redacted = redact(call)
	assert.equal(typeof redacted.data.arguments, 'string')
	assert.deepEqual(JSON.parse(redacted.data.arguments), { command: '<redacted>' })
	// Allowlisted host keys do not apply inside third-party arguments.
	const args = redact({ arguments: JSON.stringify({ target: 'https://x.example/y', name: 'a/b', kind: 'plan', n: 2 }) })
	assert.deepEqual(JSON.parse(args.arguments), { target: '<redacted>', name: '<redacted>', kind: '<redacted>', n: 2 })
	assert.deepEqual({ ...redacted.data, arguments: undefined }, { turn: 1, callId: 'call_1', name: 'pwsh', arguments: undefined })
})

const lines = [header, start, call, end]
const cases = [
	['預設去掉檔頭並遮蔽', {}, [start, redact(call), end]],
	['依型別過濾', { types: ['turn/start', 'turn/end'] }, [start, end]],
	['seq 範圍含兩端', { from: 2, to: 3 }, [redact(call), end]],
	['raw 保留原文', { types: ['tool/call'], raw: true }, [call]]
]
for (const [title, options, expected] of cases) {
	test(`selectEvents：${title}`, () => {
		assert.deepEqual(selectEvents(lines, options), expected, title)
	})
}

const argCases = [
	['只有檔案', ['log.zstd'], { file: 'log.zstd', options: { raw: false } }],
	['--raw 放在檔案前面不吃掉檔名', ['--raw', 'log.zstd'], { file: 'log.zstd', options: { raw: true } }],
	['型別與 seq 範圍', ['log.zstd', '--type', 'turn/start, turn/end', '--from=5', '--to', '9'], { file: 'log.zstd', options: { raw: false, types: ['turn/start', 'turn/end'], from: 5, to: 9 } }]
]
for (const [title, argv, expected] of argCases) {
	test(`parseEventsArgs：${title}`, () => assert.deepEqual(parseEventsArgs(argv), expected, title))
}

const argErrors = [
	['拼錯的選項', ['log.zstd', '--form', '5'], /不認得的選項 --form/],
	['--type 沒給值', ['log.zstd', '--type'], /--type 要給值/],
	['--type 後面接另一個選項', ['log.zstd', '--type', '--raw'], /--type 要給值/],
	['seq 不是整數', ['log.zstd', '--from', '1.5'], /整數 seq/],
	['--raw 帶值', ['log.zstd', '--raw=yes'], /開關/],
	['沒有檔案', ['--raw'], /路徑/],
	['兩個檔案', ['a.zstd', 'b.zstd'], /只接受一個檔案/]
]
for (const [title, argv, pattern] of argErrors) {
	test(`parseEventsArgs：${title}時報錯`, () => assert.match(parseEventsArgs(argv).error ?? '', pattern, title))
}
