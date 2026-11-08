#!/usr/bin/env node
/**
 * Command line for the same jobs the tools do, for use outside a session.
 *
 * The exit code is the contract: 0 clean, 1 the diagnosis found errors, 2 the
 * command itself could not run (bad arguments, unreadable directory).
 *
 * @module dsh-plugin-devkit/cli
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ScaffoldError, scaffoldFiles } from '../lib/scaffold.js'
import { diagnose } from '../lib/checks.js'
import { inspectProfile, inspectSummaryLine, renderInspectReport } from '../lib/inspect.js'
import { DEFAULT_PROFILE_DIR } from '../lib/profile.js'
import { readProject } from '../lib/project.js'
import { renderReport, summaryLine } from '../lib/report.js'
import { writeScaffold } from '../lib/write.js'

const USAGE = `dsh-plugin-devkit — scaffold and check DeepSeek Harness bundles

用法：
  dsh-plugin-devkit scaffold <name> [--dir <path>] [--desc <text>] [--kind tool|events] [--tool <suffix>]
                                     [--author <name>] [--no-ci] [--force] [--dry-run]
  dsh-plugin-devkit doctor <dir> [--host-version <version>] [--json]
  dsh-plugin-devkit audit <spec> [--json] [--registry=<url>] [--profile=<dir>] [--host=<version>]
  dsh-plugin-devkit inspect [name] [--json] [--profile=<dir>] [--host=<version>]

選項：
  --dir <path>           scaffold 的目標目錄（預設用套件名）
  --desc <text>          manifest 與入口檔頭的一行說明
  --kind <tool|events>   tool：註冊一個工具（預設）；events：不註冊工具，只聽 session 事件
  --tool <suffix>        範例工具的後綴（預設 hello）
  --author <name>        LICENSE 與 manifest 的著作權人
  --no-ci                不產生 .github/workflows/test.yml
  --force                覆蓋已存在的檔案
  --dry-run              只列出會寫入的檔案
  --host-version <ver>   doctor 額外做安裝期相容性判定
  --json                 doctor／audit／inspect 輸出 JSON
  --registry=<url>       audit 查詢的 registry（預設 https://registry.npmjs.org）
  --profile=<dir>        audit、inspect 讀取的 profile 目錄（預設 desktop profile）
  --host=<ver>           audit、inspect 的相容性判定基準（預設讀 DSH_VERSION）

結束碼：0 可以安裝／1 有 error 或 audit 判 block／2 指令本身無法執行／3 未核查（git、local 這類沒有跑 registry 側檢查）
`

/**
 * Read `--key value` and `--key=value` pairs plus bare flags.
 *
 * @param {string[]} argv
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
function parseArgs(argv) {
	const positional = []
	const flags = {}
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		if (!token.startsWith('--')) {
			positional.push(token)
			continue
		}
		const body = token.slice(2)
		const equals = body.indexOf('=')
		if (equals !== -1) {
			flags[body.slice(0, equals)] = body.slice(equals + 1)
			continue
		}
		const next = argv[index + 1]
		if (next !== undefined && !next.startsWith('--')) {
			flags[body] = next
			index += 1
			continue
		}
		flags[body] = true
	}
	return { positional, flags }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse the arguments that follow the `audit` subcommand.
 *
 * Split out from `main()` so the exit-code-relevant decisions (which spec, which
 * overrides, text or JSON) can be tested without spawning a process or touching
 * the network. A relative `--profile` is made absolute here, at the same place
 * the other commands resolve their paths.
 *
 * @param {string[]} argv tokens after `audit`
 * @returns {{
 *   spec?: string,
 *   format: 'text' | 'json',
 *   options: { registry?: string, profileDir?: string, hostVersion?: string },
 *   error?: string,
 * }}
 */
export function parseAuditArgs(argv, env = process.env) {
	const { positional, flags } = parseArgs(argv)
	/** @type {{ registry?: string, profileDir?: string, hostVersion?: string }} */
	const options = {}
	const registry = asString(flags.registry)
	if (registry !== undefined) options.registry = registry
	const profileDir = asString(flags.profile)
	if (profileDir !== undefined) options.profileDir = resolve(process.cwd(), profileDir)
	// `--host` wins, then the running Host's own version from the environment.
	const hostVersion = asString(flags.host) ?? asString(env?.DSH_VERSION)
	if (hostVersion !== undefined) options.hostVersion = hostVersion

	const parsed = { spec: asString(positional[0]), format: flags.json === true ? 'json' : 'text', options }
	if (positional.length > 1) {
		parsed.spec = undefined
		parsed.error = `audit：只接受一個 spec，多出來的是 ${positional
			.slice(1)
			.map((token) => JSON.stringify(token))
			.join('、')}`
	}
	return parsed
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
	if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
		process.stdout.write(USAGE)
		return argv.length === 0 ? 2 : 0
	}

	const { positional, flags } = parseArgs(argv)
	const command = positional[0]

	if (command === 'scaffold') {
		const name = positional[1]
		if (name === undefined) {
			process.stderr.write('scaffold：需要套件名稱，例如 dsh-foo-bar\n')
			return 2
		}
		let files
		try {
			files = scaffoldFiles({
				name,
				description: asString(flags.desc),
				tool: asString(flags.tool),
				author: asString(flags.author),
				ci: flags['no-ci'] !== true,
				kind: asString(flags.kind)
			})
		} catch (error) {
			if (error instanceof ScaffoldError) {
				process.stderr.write(`${error.message}\n`)
				return 2
			}
			throw error
		}
		const dir = resolve(process.cwd(), asString(flags.dir) ?? name)
		if (flags['dry-run'] === true) {
			process.stdout.write([`（試跑）${dir}`, ...files.map((file) => `· ${file.path}`), ''].join('\n'))
			return 0
		}
		const result = await writeScaffold({ dir, files, overwrite: flags.force === true })
		process.stdout.write(
			[
				`scaffold 完成：${result.root}`,
				`寫入 ${result.written.length} 個檔案，略過 ${result.skipped.length} 個已存在的檔案`,
				'',
				...result.written.map((path) => `· ${path}`),
				'',
				`下一步：cd ${result.root} && npm test && npx dsh-plugin-devkit doctor .`,
				''
			].join('\n')
		)
		return 0
	}

	if (command === 'doctor') {
		const target = positional[1]
		if (target === undefined) {
			process.stderr.write('doctor：需要目錄，例如 doctor .\n')
			return 2
		}
		const project = await readProject(resolve(process.cwd(), target))
		if (project.files['package.json'] === undefined) {
			process.stderr.write(`${project.root} 沒有 package.json\n`)
			return 2
		}
		const hostVersion = asString(flags['host-version'])
		const result = diagnose({ files: project.files, hostVersion })
		if (flags.json === true) {
			process.stdout.write(`${JSON.stringify({ root: project.root, hostVersion, ...result }, null, 2)}\n`)
		} else {
			process.stdout.write(`${renderReport(result, { root: project.root, hostVersion })}\n`)
		}
		process.stderr.write(`${summaryLine(result)}\n`)
		return result.ok ? 0 : 1
	}

	if (command === 'audit') {
		const parsed = parseAuditArgs(argv.slice(argv.indexOf('audit') + 1))
		if (parsed.error !== undefined) {
			process.stderr.write(`${parsed.error}\n`)
			return 2
		}
		if (parsed.spec === undefined) {
			process.stderr.write(`audit：需要套件 spec，例如 audit lodash@4.17.21\n\n${USAGE}`)
			return 2
		}

		let audit
		let report
		try {
			;[audit, report] = await Promise.all([import('../lib/audit.js'), import('../lib/audit-report.js')])
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			process.stderr.write(`audit：無法載入核查模組（${detail}）\n`)
			return 2
		}

		let result
		try {
			result = await audit.auditSpec(parsed.spec, parsed.options)
		} catch (error) {
			const detail = error instanceof Error ? error.stack ?? error.message : String(error)
			process.stderr.write(`audit：核查 ${parsed.spec} 時失敗（${detail}）\n`)
			return 2
		}

		process.stdout.write(`${report.renderAuditReport(result, { format: parsed.format })}\n`)
		if (typeof report.auditSummaryLine === 'function') process.stderr.write(`${report.auditSummaryLine(result)}\n`)
		// 3 is "nothing was checked": neither a pass nor a failure, and no script
		// should treat it as permission to install.
		if (result.verdict.install === 'not-audited') return 3
		return result.verdict.install === 'block' ? 1 : 0
	}

	if (command === 'inspect') {
		// Outside a running Host there is no loader, so this is the static half only.
		const result = await inspectProfile({
			profileDir: resolve(process.cwd(), asString(flags.profile) ?? DEFAULT_PROFILE_DIR),
			name: asString(positional[1]),
			hostVersion: asString(flags.host) ?? asString(process.env.DSH_VERSION),
		})
		process.stdout.write(`${flags.json === true ? JSON.stringify(result, null, 2) : renderInspectReport(result)}\n`)
		process.stderr.write(`${inspectSummaryLine(result)}\n`)
		return result.ok ? 0 : 1
	}

	process.stderr.write(`不認得的指令：${command}\n\n${USAGE}`)
	return 2
}

/**
 * Only run when this file is the program, so tests can import `parseAuditArgs`
 * without a CLI run starting underneath them.
 *
 * @param {string[]} argv
 * @param {string} moduleUrl
 * @returns {boolean}
 */
function isMainModule(argv, moduleUrl) {
	if (argv[1] === undefined) return false
	const invoked = resolve(argv[1])
	const self = resolve(fileURLToPath(moduleUrl))
	return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self
}

if (isMainModule(process.argv, import.meta.url)) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
			process.exitCode = 2
		})
}
