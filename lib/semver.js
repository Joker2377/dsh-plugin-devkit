/**
 * Semver range evaluation for plugin manifests.
 *
 * DSH answers one question before it installs a bundle: does this plugin's
 * `engines.dsh` — or, when it has none, every `@deepseek-ai/dsh*` peer — accept
 * the running DSH version? It does that with
 * `semver.satisfies(version, range, { includePrerelease: true })`
 * (`@deepseek-ai/dsh-app-boot`, `unmetRequirements()`), so prereleases take part
 * in ranges. This module reproduces that answer without pulling in a dependency.
 *
 * Supported: `=` `>` `>=` `<` `<=`, the `^` and `~` shorthands, space-separated
 * comparator sets, `||` alternatives, and `*` / `x` wildcards.
 * Not supported: hyphen ranges (`1.2.3 - 2.0.0`) and build metadata (ignored).
 *
 * @module dsh-plugin-devkit/semver
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/

/**
 * Parse one version, keeping the exact prerelease identifiers.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | undefined}
 */
export function parseVersion(text) {
	const match = VERSION_RE.exec(String(text ?? '').trim())
	if (!match) return undefined
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split('.'),
	}
}

/**
 * Compare two prerelease identifier lists, semver 11.4 order.
 *
 * A release outranks its own prereleases; numeric identifiers rank below
 * alphanumeric ones; a shorter list that is a prefix ranks lower.
 *
 * @param {string[]} left
 * @param {string[]} right
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(left, right) {
	if (left.length === 0 && right.length === 0) return 0
	if (left.length === 0) return 1
	if (right.length === 0) return -1
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const a = left[index]
		const b = right[index]
		if (a === undefined) return -1
		if (b === undefined) return 1
		const aNumeric = /^\d+$/.test(a)
		const bNumeric = /^\d+$/.test(b)
		if (aNumeric && bNumeric) {
			const delta = Number(a) - Number(b)
			if (delta !== 0) return delta < 0 ? -1 : 1
			continue
		}
		if (aNumeric) return -1
		if (bNumeric) return 1
		if (a !== b) return a < b ? -1 : 1
	}
	return 0
}

/**
 * Compare two versions. Accepts raw strings or parsed versions.
 *
 * @param {string | object} left
 * @param {string | object} right
 * @returns {-1 | 0 | 1 | undefined} undefined when either side is not a version
 */
export function compareVersions(left, right) {
	const a = typeof left === 'string' ? parseVersion(left) : left
	const b = typeof right === 'string' ? parseVersion(right) : right
	if (!a || !b) return undefined
	for (const key of ['major', 'minor', 'patch']) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
	}
	return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * Expand one range token into the comparators it means.
 *
 * @param {string} token
 * @returns {Array<{ op: string, version: object }> | undefined}
 */
function expandToken(token) {
	const match = COMPARATOR_RE.exec(token)
	if (!match) return undefined
	const op = match[1] ?? '='
	const body = match[2].trim()
	if (body === '*' || body === 'x' || body === 'X') return []
	if (op === '^' || op === '~') {
		const base = parseVersion(body)
		if (!base) return undefined
		let upper
		if (op === '~') {
			upper = { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] }
		} else if (base.major > 0) {
			upper = { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
		} else if (base.minor > 0) {
			upper = { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
		} else {
			upper = { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] }
		}
		return [{ op: '>=', version: base }, { op: '<', version: upper }]
	}
	const version = parseVersion(body)
	if (!version) return undefined
	return [{ op, version }]
}

/**
 * Parse a range into alternatives of comparator sets.
 *
 * A caller needs the distinction `valid` carries: an unreadable range is a
 * manifest problem, while a readable but unmet range is a compatibility
 * verdict. `satisfies()` collapses both into `false`.
 *
 * @param {unknown} range
 * @returns {{ valid: boolean, reason?: string, alternatives: Array<Array<{ op: string, version: object }>> }}
 */
export function parseRange(range) {
	const text = String(range ?? '').trim()
	if (text === '') return { valid: false, reason: '空的範圍字串', alternatives: [] }
	const alternatives = []
	for (const part of text.split('||')) {
		const tokens = part.trim().split(/\s+/).filter(Boolean)
		if (tokens.length === 0) return { valid: false, reason: '空白的 || 分支', alternatives: [] }
		const comparators = []
		for (const token of tokens) {
			const expanded = expandToken(token)
			if (expanded === undefined) {
				return { valid: false, reason: `無法解析的比較子 ${JSON.stringify(token)}`, alternatives: [] }
			}
			comparators.push(...expanded)
		}
		alternatives.push(comparators)
	}
	return { valid: true, alternatives }
}

/**
 * Does `version` fall inside `range`? Prereleases participate, as they do in DSH.
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
	const target = parseVersion(version)
	const parsed = parseRange(range)
	if (!target || !parsed.valid) return false
	for (const comparators of parsed.alternatives) {
		let matched = true
		for (const { op, version: bound } of comparators) {
			const order = compareVersions(target, bound)
			const failed =
				op === '>=' ? order < 0
					: op === '<=' ? order > 0
						: op === '>' ? order <= 0
							: op === '<' ? order >= 0
								: order !== 0
			if (failed) {
				matched = false
				break
			}
		}
		if (matched) return true
	}
	return false
}
