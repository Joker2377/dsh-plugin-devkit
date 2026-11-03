/**
 * The two tools this bundle puts in front of the model.
 *
 * `plugin_scaffold` writes a bundle skeleton; `plugin_doctor` reads an existing
 * bundle and says what would stop it from installing. Both are thin: the shape of
 * the skeleton lives in `scaffold.js`, the opinions live in `checks.js`, and this
 * file only joins those to the filesystem.
 *
 * `defineTool` is imported dynamically with an identity fallback so this module
 * can be imported by plain Node during tests, exactly like a bundle that ships
 * tools is expected to.
 *
 * @module dsh-plugin-devkit/tools
 */

import { resolve } from 'node:path'

import { ScaffoldError, scaffoldFiles, toolNameFor } from './scaffold.js'
import { diagnose } from './checks.js'
import { readProject } from './project.js'
import { renderReport } from './report.js'
import { writeScaffold } from './write.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools')
	.catch(() => ({ defineTool: (definition) => definition }))

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalString(value) {
	if (typeof value !== 'string') return undefined
	const text = value.trim()
	return text === '' ? undefined : text
}

/**
 * Resolve a caller-supplied directory against the host process cwd and report the
 * absolute result, so a relative guess is visible instead of silent.
 *
 * @param {unknown} dir
 * @param {string} fallback
 * @returns {string}
 */
function resolveDir(dir, fallback) {
	const text = optionalString(dir) ?? fallback
	return resolve(process.cwd(), text)
}

/**
 * @returns {object} the `plugin_scaffold` tool definition
 */
export function createScaffoldTool() {
	return defineTool({
		name: 'plugin_scaffold',
		description: [
			'Create a DeepSeek Harness bundle skeleton in a directory: package.json with dsh.bundle.patch, a patch that inserts one Loader row, ',
			'a host entry exporting name/inject/apply, one example tool behind a defineTool import that degrades outside DSH, a bundle test, ',
			'README written as usage guidance, LICENSE, .gitignore and a CI workflow. ',
			'The result passes plugin_doctor and its own `npm test` without installing any dependency. ',
			'Pass an absolute `dir` when the host process cwd is not the workspace you mean; the reply always states the absolute path used.',
		].join(''),
		parameters: {
			name: {
				type: 'string',
				required: true,
				description: 'Package name, e.g. dsh-foo-bar. Lowercase letters, digits, - . _; a @scope/ prefix is allowed.',
			},
			dir: {
				type: 'string',
				description: 'Target directory. Defaults to the package name; relative paths resolve against the host process cwd.',
			},
			description: {
				type: 'string',
				description: 'One line for package.json and the entry header: what this bundle does.',
			},
			tool: {
				type: 'string',
				description: 'Suffix of the example tool name (default hello). The full name is prefixed with the bundle slug.',
			},
			author: {
				type: 'string',
				description: 'Copyright holder for LICENSE and the manifest author field.',
			},
			ci: {
				type: 'boolean',
				description: 'Include .github/workflows/test.yml (default true).',
			},
			overwrite: {
				type: 'boolean',
				description: 'Replace files that already exist (default false: existing files are left alone and reported).',
			},
			dryRun: {
				type: 'boolean',
				description: 'List the files that would be written without touching the disk.',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		timeoutMs: 30000,
		// Writes to a caller-chosen directory: not safe to run twice at once.
		isConcurrencySafe: () => false,
		async execute(args) {
			const name = optionalString(args?.name)
			if (name === undefined) return 'plugin_scaffold: `name` 不能為空。'

			let files
			try {
				files = scaffoldFiles({
					name,
					description: optionalString(args?.description),
					tool: optionalString(args?.tool),
					author: optionalString(args?.author),
					ci: args?.ci !== false,
				})
			} catch (error) {
				if (error instanceof ScaffoldError) return `plugin_scaffold: ${error.message}`
				throw error
			}

			const dir = resolveDir(args?.dir, name)
			if (args?.dryRun === true) {
				return [
					`plugin_scaffold（試跑，未寫入）`,
					`目錄：${dir}`,
					'',
					...files.map((file) => `· ${file.path}`),
					'',
					'去掉 dryRun 才會真的寫入。',
				].join('\n')
			}

			const result = await writeScaffold({ dir, files, overwrite: args?.overwrite === true })
			const lines = [`plugin_scaffold 完成`, `目錄：${result.root}`, '']
			lines.push(`寫入 ${result.written.length} 個檔案：`)
			for (const path of result.written) lines.push(`· ${path}`)
			if (result.skipped.length > 0) {
				lines.push('', `略過 ${result.skipped.length} 個已存在的檔案（要覆蓋請加 overwrite）：`)
				for (const path of result.skipped) lines.push(`· ${path}`)
			}
			lines.push(
				'',
				'接下來：',
				`1. cd ${result.root}`,
				'2. npm test —— 不需要安裝依賴',
				`3. plugin_doctor 看還缺什麼`,
				`4. 把 lib/tools.js 裡的 ${toolNameFor(name, optionalString(args?.tool) ?? 'hello')} 換成真的工具`,
				'5. README 的安裝段補上你的倉庫網址'
			)
			return lines.join('\n')
		},
	})
}

/**
 * @returns {object} the `plugin_doctor` tool definition
 */
export function createDoctorTool() {
	return defineTool({
		name: 'plugin_doctor',
		description: [
			'Check whether a directory holds a DeepSeek Harness bundle that can actually be installed, and report what would stop it. ',
			'Read-only. Checks the manifest (name, version, type, main/exports targets, dsh.bundle.patch, files coverage, peerDependencies), ',
			'the patch (insert id, module name, config without a Config export), the entry (name, apply), the docs (README install section, LICENSE), ',
			'tests and CI. With `hostVersion` it also reproduces DSH own compatibility verdict: engines.dsh decides alone when present, ',
			'otherwise every @deepseek-ai/dsh* peer must accept the running version. Errors block installation; warnings do not.',
		].join(''),
		parameters: {
			dir: {
				type: 'string',
				required: true,
				description: 'Bundle directory to inspect. Relative paths resolve against the host process cwd.',
			},
			hostVersion: {
				type: 'string',
				description: 'Running DSH version, e.g. 0.2.1-rc.5. Enables the install-time compatibility verdict.',
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		timeoutMs: 30000,
		isConcurrencySafe: () => true,
		async execute(args) {
			const requested = optionalString(args?.dir)
			if (requested === undefined) return 'plugin_doctor: `dir` 不能為空。'
			const root = resolve(process.cwd(), requested)
			const project = await readProject(root)
			if (project.files['package.json'] === undefined) {
				return `plugin_doctor ${root}\n\n這個目錄沒有 package.json，不像是外掛套件。`
			}
			const result = diagnose({ files: project.files, hostVersion: optionalString(args?.hostVersion) })
			return renderReport(result, { root: project.root, hostVersion: optionalString(args?.hostVersion) })
		},
	})
}

/**
 * @returns {object[]} both tool definitions, in registration order
 */
export function createDevkitTools() {
	return [createScaffoldTool(), createDoctorTool()]
}
