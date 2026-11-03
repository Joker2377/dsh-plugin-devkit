/**
 * Write a generated file list to disk.
 *
 * Two rules make this safe to hand a model:
 * - an existing file is never replaced unless the caller asked for it;
 * - every path is reported back in absolute form, so the caller can see exactly
 *   where the bytes landed instead of trusting a relative guess.
 *
 * @module dsh-plugin-devkit/write
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/**
 * @param {object} input
 * @param {string} input.dir target directory
 * @param {Array<{ path: string, content: string }>} input.files the scaffold output
 * @param {boolean} [input.overwrite] replace existing files instead of skipping them
 * @returns {Promise<{ root: string, written: string[], skipped: string[] }>}
 */
export async function writeScaffold({ dir, files, overwrite = false }) {
	const root = resolve(String(dir ?? '.'))
	const written = []
	const skipped = []
	for (const file of files) {
		const target = join(root, file.path)
		if (!overwrite && (await exists(target))) {
			skipped.push(file.path)
			continue
		}
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, file.content, 'utf8')
		written.push(file.path)
	}
	return { root, written, skipped }
}
