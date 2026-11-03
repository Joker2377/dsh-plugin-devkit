import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePatch } from '../lib/yaml.js'

test('讀得懂工作區既有的 patch 形狀', () => {
	const patch = parsePatch([
		'# 說明用的註解',
		'- insert:',
		'    - id: taskbar-status',
		'      name: dsh-taskbar-status',
		'      config: {}',
		''
	].join('\n'))

	assert.deepEqual(patch.kinds, ['insert'])
	assert.equal(patch.inserts.length, 1)
	assert.equal(patch.inserts[0].id, 'taskbar-status')
	assert.equal(patch.inserts[0].name, 'dsh-taskbar-status')
	assert.deepEqual(patch.problems, [])
})

test('scoped 套件名去引號，區塊型 config 只記有沒有給', () => {
	const patch = parsePatch([
		'- insert:',
		'    - id: scholar',
		"      name: '@local/dsh-scholar'",
		'      config:',
		'        # 巢狀設定與註解都不影響 id/name',
		"        semanticScholarApiKey: ''",
		''
	].join('\n'))

	assert.equal(patch.inserts[0].name, '@local/dsh-scholar')
	assert.equal(patch.inserts[0].hasConfig, true)
	assert.equal(patch.inserts[0].configText, '')
	assert.deepEqual(patch.problems, [])
})

test('行尾註解會被剝掉，引號內的 # 保留', () => {
	const patch = parsePatch([
		'- insert:',
		'    - id: demo   # 行尾註解',
		'      name: "dsh-demo#1"',
		''
	].join('\n'))

	assert.equal(patch.inserts[0].id, 'demo')
	assert.equal(patch.inserts[0].name, 'dsh-demo#1')
})

test('沒有 insert 時回報空清單，不假裝成功', () => {
	const patch = parsePatch('# 只有註解\n')
	assert.deepEqual(patch.inserts, [])
	assert.deepEqual(patch.kinds, [])
})

test('看不懂的行進 problems，而不是被靜默吞掉', () => {
	const patch = parsePatch(['- insert:', '  亂寫的內容', ''].join('\n'))
	assert.equal(patch.problems.length, 1)
	assert.match(patch.problems[0], /無法歸位/)
})

test('override 之類的項目只記下種類，不假裝解析', () => {
	const patch = parsePatch(['- override:', '    - id: x', ''].join('\n'))
	assert.deepEqual(patch.kinds, ['override'])
	assert.deepEqual(patch.inserts, [])
})
