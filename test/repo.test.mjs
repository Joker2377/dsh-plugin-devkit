/**
 * Dogfooding: this repository must pass its own doctor, and its own entry must
 * register both tools. If either stops being true, the suite says so.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'
import { diagnose } from '../lib/checks.js'
import { readProject } from '../lib/project.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('本 repo 通過自己的檢查', async () => {
	const project = await readProject(repoRoot)
	const result = diagnose({ files: project.files })
	assert.deepEqual(result.counts.error, 0, JSON.stringify(result.findings, null, 2))
	assert.equal(result.ok, true)
})

test('本 repo 的 manifest 與 patch 彼此對得上', async () => {
	const project = await readProject(repoRoot)
	const manifest = JSON.parse(project.files['package.json'])
	assert.equal(manifest.name, name)
	assert.equal(manifest.version, '0.1.0')
	assert.ok(inject.includes('tools'))
	assert.match(project.files['cordis.patch.yml'], /id: plugin-devkit/)
	assert.match(project.files['cordis.patch.yml'], /name: dsh-plugin-devkit/)
})

test('apply() 註冊兩個工具，名字固定', () => {
	const registered = []
	const ctx = { tools: { register: (definition) => {
		registered.push(definition)
		return () => {}
	} } }
	apply(ctx)
	assert.deepEqual(registered.map((definition) => definition.name).sort(), ['plugin_doctor', 'plugin_scaffold'])
	for (const definition of registered) {
		assert.ok(typeof definition.description === 'string' && definition.description.length > 40)
		assert.equal(typeof definition.execute, 'function')
	}
})
