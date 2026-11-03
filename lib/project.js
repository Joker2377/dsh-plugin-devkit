/**
 * Read a project directory into the snapshot `diagnose()` consumes.
 *
 * Reading is deliberately shallow and bounded: the manifest, the patch, the
 * README, the licence, whatever the manifest points at, and the files directly
 * inside `test/`, `tests/` and `.github/workflows/`. A diagnosis does not need
 * `node_modules`, and crawling one would be both slow and wrong.
 *
 * @module dsh-plugin-devkit/project
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { normalizeRel } from './checks.js'

const ALWAYS = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
const SCANNED_DIRS = ['test', 'tests', '.github/workflows']
/** A test directory with more files than this is not what this reader is for. */
const MAX_DIR_FILES = 40

/**
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readTextIfFile(path) {
	try {
		const info = await stat(path)
		if (!info.isFile()) return undefined
		return await readFile(path, 'utf8')
	} catch {
		return undefined
	}
}

/**
 * @param {object} manifest parsed package.json
 * @returns {string[]} the relative paths the manifest promises to ship
 */
function declaredPaths(manifest) {
	const paths = [typeof manifest.main === 'string' ? manifest.main : 'lib/index.js']
	const exportsField = manifest.exports
	if (exportsField !== undefined && typeof exportsField === 'object' && exportsField !== null) {
		for (const value of Object.values(exportsField)) {
			if (typeof value === 'string') paths.push(value)
			else if (value && typeof value === 'object' && typeof value.default === 'string') paths.push(value.default)
		}
	}
	const patch = manifest.dsh && manifest.dsh.bundle && manifest.dsh.bundle.patch
	if (typeof patch === 'string') paths.push(patch)
	return paths
}

/**
 * @param {string} root directory to read
 * @returns {Promise<{ root: string, files: Record<string, string> }>}
 */
export async function readProject(root) {
	const dir = resolve(String(root ?? '.'))
	const files = {}
	const put = async (relativePath) => {
		if (relativePath === 'package.json') return
		const content = await readTextIfFile(join(dir, relativePath))
		if (content !== undefined) files[relativePath] = content
	}

	for (const relativePath of ALWAYS) {
		const content = await readTextIfFile(join(dir, relativePath))
		if (content !== undefined) files[relativePath] = content
	}

	const manifestText = files['package.json']
	if (manifestText !== undefined) {
		let manifest
		try {
			manifest = JSON.parse(manifestText)
		} catch {
			manifest = undefined
		}
		if (manifest !== undefined && typeof manifest === 'object' && manifest !== null) {
			for (const declared of declaredPaths(manifest)) {
				const relativePath = normalizeRel(declared)
				if (relativePath !== '') await put(relativePath)
			}
		}
	}

	for (const scanned of SCANNED_DIRS) {
		let entries
		try {
			entries = await readdir(join(dir, scanned), { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries.slice(0, MAX_DIR_FILES)) {
			if (!entry.isFile()) continue
			await put(`${scanned}/${entry.name}`)
		}
	}

	return { root: dir, files }
}
