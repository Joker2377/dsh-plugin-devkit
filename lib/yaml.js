/**
 * A tolerant reader for the patch dialect DSH bundles ship.
 *
 * A bundle patch is a short YAML list — `- insert:`, `- override:`, `- group:`,
 * `- disabled:` — whose `insert` entries name a Loader id, a module and an
 * optional config block. That is all this reader understands, and it reports
 * anything it could not place instead of pretending to be a YAML parser.
 * Full YAML would mean a dependency; the dialect a patch actually uses does not
 * need one.
 *
 * @module dsh-plugin-devkit/yaml
 */

const ITEM_RE = /^-\s+([A-Za-z][\w-]*)\s*:\s*$/
const ENTRY_RE = /^(\s+)-\s+id\s*:\s*(.*)$/
const FIELD_RE = /^(\s+)([A-Za-z][\w-]*)\s*:\s*(.*)$/

/**
 * Drop a trailing `# comment`, leaving `#` inside quotes alone.
 *
 * @param {string} value
 * @returns {string}
 */
function stripComment(value) {
	let quote
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index]
		if (quote !== undefined) {
			if (char === quote) quote = undefined
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
			return value.slice(0, index).trim()
		}
	}
	return value.trim()
}

/**
 * Remove one layer of matching quotes.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
	const text = value.trim()
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1)
	return text
}

/**
 * Read a bundle patch.
 *
 * `kinds` lists the top-level item keys the file used, so a caller can say
 * "this patch also overrides rows" without this reader having to model it.
 *
 * @param {unknown} text
 * @returns {{
 *   kinds: string[],
 *   inserts: Array<{ id: string, name: string | undefined, hasConfig: boolean, configText: string }>,
 *   problems: string[],
 * }}
 */
export function parsePatch(text) {
	const kinds = []
	const inserts = []
	const problems = []
	let itemKind
	let current

	const lines = String(text ?? '').split(/\r?\n/)
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.replace(/\s+$/, '')
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue

		const item = ITEM_RE.exec(line)
		if (item) {
			itemKind = item[1]
			kinds.push(itemKind)
			current = undefined
			continue
		}

		if (itemKind === undefined) {
			problems.push(`第 ${index + 1} 行不在任何 list item 內：${trimmed}`)
			continue
		}

		// `override:` and friends take a different shape; this reader does not
		// model them, and says so through `kinds`.
		if (itemKind !== 'insert') continue

		const entry = ENTRY_RE.exec(line)
		if (entry) {
			current = {
				id: unquote(stripComment(entry[2])),
				name: undefined,
				hasConfig: false,
				configText: ''
			}
			inserts.push(current)
			continue
		}

		const field = FIELD_RE.exec(line)
		if (!field) {
			problems.push(`第 ${index + 1} 行無法歸位：${trimmed}`)
			continue
		}
		if (current === undefined) {
			problems.push(`第 ${index + 1} 行的欄位沒有所屬的 insert 項目：${trimmed}`)
			continue
		}
		const key = field[2]
		const value = stripComment(field[3])
		if (key === 'name') current.name = unquote(value)
		else if (key === 'config') {
			current.hasConfig = true
			current.configText = value
		}
	}

	for (const [index, insert] of inserts.entries()) {
		if (insert.id === '') problems.push(`第 ${index + 1} 個 insert 項目沒有 id`)
	}
	return { kinds, inserts, problems }
}
