import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSpec } from '../lib/spec.js'

test('裸套件名就是 registry 的 latest', () => {
	assert.deepEqual(parseSpec('dsh-foo-bar'), { kind: 'registry', name: 'dsh-foo-bar', range: 'latest', raw: 'dsh-foo-bar' })
})

test('版本與範圍留在 range，名稱不受最後一個 @ 影響', () => {
	assert.equal(parseSpec('dsh-foo-bar@1.2.3').range, '1.2.3')
	assert.equal(parseSpec('dsh-foo-bar@1.2.3').name, 'dsh-foo-bar')
	assert.equal(parseSpec('dsh-foo-bar@^1').range, '^1')
	assert.equal(parseSpec('dsh-foo-bar@>=1.0.0').range, '>=1.0.0')
})

test('scoped 名稱取第一個 @ 當 scope、最後一個 @ 之後當 range', () => {
	assert.deepEqual(parseSpec('@scope/name@1.0.0-rc.1'), {
		kind: 'registry',
		name: '@scope/name',
		range: '1.0.0-rc.1',
		raw: '@scope/name@1.0.0-rc.1',
	})
	assert.deepEqual(parseSpec('@scope/name'), { kind: 'registry', name: '@scope/name', range: 'latest', raw: '@scope/name' })
	assert.equal(parseSpec('@scope/name@~1.2').range, '~1.2')
})

test('github: 簡寫正規化成 https 的 .git 位址', () => {
	assert.deepEqual(parseSpec('github:owner/repo'), { kind: 'git', url: 'https://github.com/owner/repo.git', raw: 'github:owner/repo' })
	assert.equal(parseSpec('github:owner/repo.git').url, 'https://github.com/owner/repo.git')
	assert.equal(parseSpec('github:owner/repo').kind, 'git')
})

test('git+ 位址去掉前綴但保留原 scheme', () => {
	assert.equal(parseSpec('git+https://github.com/owner/repo.git').url, 'https://github.com/owner/repo.git')
	assert.equal(parseSpec('git+ssh://git@github.com/owner/repo.git').url, 'ssh://git@github.com/owner/repo.git')
	assert.equal(parseSpec('git+https://github.com/owner/repo.git').kind, 'git')
})

test('GitHub 網址是 git，不會被吃成 registry 名稱', () => {
	assert.equal(parseSpec('https://github.com/owner/repo').kind, 'git')
	assert.equal(parseSpec('https://github.com/owner/repo.git').url, 'https://github.com/owner/repo')
	assert.equal(parseSpec('https://github.com/owner/repo/').kind, 'git')
	assert.equal(parseSpec('https://github.com/owner/repo').raw, 'https://github.com/owner/repo')
})

test('本機路徑：絕對、相對、file:、link:', () => {
	const windowsPath = String.raw`C:\Users\me\plugin`
	for (const [spec, path] of [
		['/home/me/plugin', '/home/me/plugin'],
		['C:/Users/me/plugin', 'C:/Users/me/plugin'],
		[windowsPath, windowsPath],
		['./plugin', './plugin'],
		['../plugin', '../plugin'],
		['file:./plugin', './plugin'],
		['link:../plugin', '../plugin'],
		['.', '.'],
		['..', '..'],
	]) {
		assert.deepEqual(parseSpec(spec), { kind: 'local', path, raw: spec })
	}
})

test('空字串、空白、看不懂的形式都是 invalid', () => {
	assert.equal(parseSpec('').kind, 'invalid')
	assert.equal(parseSpec('   ').kind, 'invalid')
	assert.equal(parseSpec('dsh foo').kind, 'invalid')
	assert.equal(parseSpec('@scope').kind, 'invalid')
	assert.equal(parseSpec('https://example.com/pkg.tgz').kind, 'invalid')
	assert.equal(parseSpec('file:').kind, 'invalid')
	assert.equal(parseSpec(undefined).kind, 'invalid')
	assert.equal(parseSpec(42).kind, 'invalid')
})

test('invalid 一定帶原因與原字串', () => {
	const result = parseSpec('dsh foo')
	assert.equal(result.raw, 'dsh foo')
	assert.equal(typeof result.reason, 'string')
	assert.ok(result.reason.length > 0)
})
