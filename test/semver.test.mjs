import assert from 'node:assert/strict'
import test from 'node:test'

import { compareVersions, parseRange, parseVersion, satisfies } from '../lib/semver.js'

/** The window DSH itself publishes for this generation of Host. */
const HOST_RANGE = '>=0.1.1-rc.2 <0.3.0'
/** The window the official tool packages publish; the second branch is 0.2.x. */
const TOOLS_RANGE = '>=0.1.0-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0'

test('版本解析保留 prerelease 識別碼', () => {
	assert.deepEqual(parseVersion('0.2.1-rc.5'), {
		major: 0,
		minor: 2,
		patch: 1,
		prerelease: ['rc', '5']
	})
	assert.equal(parseVersion('v1.2.3').major, 1)
	assert.equal(parseVersion('1.2'), undefined)
	assert.equal(parseVersion(''), undefined)
})

test('prerelease 排序低於同號正式版', () => {
	assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-alpha.2'), 1)
	assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
	assert.equal(compareVersions('nope', '1.0.0'), undefined)
})

test('Host 範圍：本機 0.2.1-rc.5 落在可接受區間', () => {
	assert.equal(satisfies('0.2.1-rc.5', HOST_RANGE), true)
	assert.equal(satisfies('0.3.0', HOST_RANGE), false)
	// includePrerelease 語義：0.3.0-rc.5 仍小於 0.3.0，所以在區間內。
	assert.equal(satisfies('0.3.0-rc.5', HOST_RANGE), true)
	assert.equal(satisfies('0.1.0', HOST_RANGE), false)
})

test('|| 分支：只採用其中一條', () => {
	assert.equal(satisfies('0.2.1-rc.5', TOOLS_RANGE), true)
	assert.equal(satisfies('0.1.5', TOOLS_RANGE), true)
	assert.equal(satisfies('0.2.0-rc.5', TOOLS_RANGE), true)
	assert.equal(satisfies('0.0.9', TOOLS_RANGE), false)
})

test('^ 與 ~ 展開成上下界', () => {
	assert.equal(satisfies('4.5.0', '^4.0.1'), true)
	assert.equal(satisfies('5.0.0', '^4.0.1'), false)
	assert.equal(satisfies('0.2.9', '^0.2.3'), true)
	assert.equal(satisfies('0.3.0', '^0.2.3'), false)
	assert.equal(satisfies('0.0.3', '^0.0.3'), true)
	assert.equal(satisfies('0.0.4', '^0.0.3'), false)
	assert.equal(satisfies('1.2.9', '~1.2.3'), true)
	assert.equal(satisfies('1.3.0', '~1.2.3'), false)
})

test('無法解析的範圍與空範圍都判定為不通過', () => {
	const parsed = parseRange('not-a-range')
	assert.equal(parsed.valid, false)
	assert.equal(typeof parsed.reason, 'string')
	assert.equal(satisfies('1.0.0', 'not-a-range'), false)
	assert.equal(satisfies('1.0.0', ''), false)
	assert.equal(satisfies('1.0.0', '>=1.0.0 ||'), false)
})

test('* 與 x 接受任何版本', () => {
	assert.equal(satisfies('0.0.1', '*'), true)
	assert.equal(satisfies('9.9.9', 'x'), true)
})
