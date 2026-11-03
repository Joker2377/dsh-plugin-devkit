/**
 * One spec string in, one place to look up.
 *
 * A spec is what someone typed: `dsh-foo`, `dsh-foo@^1.2.0`, `@scope/name@1.0.0`,
 * `github:owner/repo`, `git+https://host/repo.git`, `https://github.com/owner/repo`,
 * a directory path, or a `file:` / `link:` reference. Parsing is pure — no
 * filesystem, no network — so the audit can classify a spec before touching
 * anything, and that class decides whether the registry-side checks apply at all.
 *
 * The registry range is intentionally left unvalidated: `parseRange()` owns that
 * judgement, and a readable but unsatisfiable range must stay a version problem
 * (`audit/version-missing`), not a parse problem (`audit/spec-invalid`).
 *
 * @module dsh-plugin-devkit/spec
 */

/** A name npm would accept, scoped or not. */
const NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
/** npm's own limit for a whole package name. */
const MAX_NAME_LENGTH = 214
/** `github:owner/repo`, with the optional `.git` spelling. */
const GITHUB_SHORTHAND_RE = /^github:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/
/** `https://github.com/owner/repo`, optional `.git`, optional trailing slash. */
const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/
/** npm's `git+<scheme>://…` spelling. */
const GIT_PLUS_RE = /^git\+(https?|ssh|git|file):\/\/(.+)$/
/** `file:` / `link:` dependency prefixes. */
const PREFIX_RE = /^(file|link):(.*)$/

/**
 * @param {string} raw
 * @param {string} reason
 * @returns {{ kind: 'invalid', reason: string, raw: string }}
 */
function invalid(raw, reason) {
	return { kind: 'invalid', reason, raw }
}

/**
 * Would this string point at a directory on disk? Backslashes are folded to `/`
 * first, so Windows forms and their mixed spellings are recognised too.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function looksLocal(raw) {
	const path = raw.replace(/\\/g, '/')
	return (
		/^[A-Za-z]:\//.test(path) ||
		path.startsWith('/') ||
		path === '.' ||
		path === '..' ||
		path.startsWith('./') ||
		path.startsWith('../')
	)
}

/**
 * Parse a spec into the one thing the audit has to do with it.
 *
 * Scoped names own their first `@`; the range starts after the **last** one, so
 * `@scope/name@1.0.0` keeps the scope and `@scope/name` still means `latest`.
 *
 * @param {unknown} spec raw argument, e.g. `dsh-foo@^1`
 * @returns {
 *   | { kind: 'registry', name: string, range: string, raw: string }
 *   | { kind: 'git', url: string, raw: string }
 *   | { kind: 'local', path: string, raw: string }
 *   | { kind: 'invalid', reason: string, raw: string }
 * }
 */
export function parseSpec(spec) {
	if (typeof spec !== 'string') return invalid(String(spec ?? ''), 'spec 必須是字串')
	const raw = spec
	if (raw.trim() === '') return invalid(raw, 'spec 是空的')
	if (/\s/.test(raw)) return invalid(raw, `spec 不能包含空白：${JSON.stringify(raw)}`)

	const prefixed = PREFIX_RE.exec(raw)
	if (prefixed !== null) {
		const path = prefixed[2]
		if (path === '') return invalid(raw, `${prefixed[1]}: 之後沒有路徑`)
		return { kind: 'local', path, raw }
	}
	if (looksLocal(raw)) return { kind: 'local', path: raw, raw }

	const shorthand = GITHUB_SHORTHAND_RE.exec(raw)
	if (shorthand !== null) {
		return { kind: 'git', url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, raw }
	}
	const gitPlus = GIT_PLUS_RE.exec(raw)
	if (gitPlus !== null) return { kind: 'git', url: `${gitPlus[1]}://${gitPlus[2]}`, raw }
	const githubUrl = GITHUB_URL_RE.exec(raw)
	if (githubUrl !== null) {
		return { kind: 'git', url: `https://github.com/${githubUrl[1]}/${githubUrl[2]}`, raw }
	}

	const at = raw.lastIndexOf('@')
	const name = at > 0 ? raw.slice(0, at) : raw
	const range = (at > 0 ? raw.slice(at + 1) : '') || 'latest'
	if (name.length > MAX_NAME_LENGTH) return invalid(raw, `套件名超過 ${MAX_NAME_LENGTH} 字元`)
	if (!NAME_RE.test(name)) {
		return invalid(raw, `看不懂這個 spec：${JSON.stringify(raw)}——既不是 npm 套件名、git 位址，也不是本機路徑`)
	}
	return { kind: 'registry', name, range, raw }
}
