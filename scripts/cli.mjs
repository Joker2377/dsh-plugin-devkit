#!/usr/bin/env node
/**
 * Command line for the same two jobs the tools do, for use outside a session.
 *
 * The exit code is the contract: 0 clean, 1 the diagnosis found errors, 2 the
 * command itself could not run (bad arguments, unreadable directory).
 *
 * @module dsh-plugin-devkit/cli
 */

import { resolve } from 'node:path'

import { ScaffoldError, scaffoldFiles } from '../lib/scaffold.js'
import { diagnose } from '../lib/checks.js'
import { readProject } from '../lib/project.js'
import { renderReport, summaryLine } from '../lib/report.js'
import { writeScaffold } from '../lib/write.js'

const USAGE = `dsh-plugin-devkit — scaffold and check DeepSeek Harness bundles

用法：
  dsh-plugin-devkit scaffold <name> [--dir <path>] [--desc <text>] [--tool <suffix>]
                                     [--author <name>] [--no-ci] [--force] [--dry-run]
  dsh-plugin-devkit doctor <dir> [--host-version <version>] [--json]

選項：
  --dir <path>           scaffold 的目標目錄（預設用套件名）
  --desc <text>          manifest 與入口檔頭的一行說明
  --tool <suffix>        範例工具的後綴（預設 hello）
  --author <name>        LICENSE 與 manifest 的著作權人
  --no-ci                不產生 .github/workflows/test.yml
  --force                覆蓋已存在的檔案
  --dry-run              只列出會寫入的檔案
  --host-version <ver>   doctor 額外做安裝期相容性判定
  --json                 doctor 輸出 JSON

結束碼：0 通過／1 有 error／2 指令本身無法執行
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
				ci: flags['no-ci'] !== true
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

	process.stderr.write(`不認得的指令：${command}\n\n${USAGE}`)
	return 2
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code
	})
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
		process.exitCode = 2
	})
