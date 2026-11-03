/**
 * The three tools this bundle puts in front of the model.
 *
 * `plugin_scaffold` writes a bundle skeleton; `plugin_doctor` reads an existing
 * bundle and says what would stop it from installing; `plugin_audit` reads a
 * third-party package from the registry (read-only, nothing installed) and says
 * whether its supply-chain signals allow installing it. All three are thin: the
 * shape of the skeleton lives in `scaffold.js`, the opinions in `checks.js`, the
 * registry work in `audit.js`, and this file only joins those to the outside
 * world.
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

let auditModules

/**
 * Load the pre-install audit pipeline on first use.
 *
 * The import stays dynamic on purpose: a bundle's tool list must keep loading
 * even when one of its modules is missing or broken, and a top-level import
 * would take the whole plugin down before any tool could explain itself. A
 * failure here becomes one readable line in the tool result instead.
 *
 * @returns {Promise<{
 *   auditSpec: (spec: string, options?: object) => Promise<object>,
 *   renderAuditReport: (result: object, options?: { format?: 'text' | 'json' }) => string,
 * }>}
 */
function loadAuditModules() {
	if (auditModules !== undefined) return auditModules
	const pending = Promise.all([import('./audit.js'), import('./audit-report.js')]).then(
		([audit, report]) => ({ auditSpec: audit.auditSpec, renderAuditReport: report.renderAuditReport })
	)
	auditModules = pending
	// A retry after a transient load failure should be possible on the next call.
	pending.catch(() => {
		if (auditModules === pending) auditModules = undefined
	})
	return pending
}

/**
 * `format` is a closed set: anything that is not `json` renders as text, so a
 * typo never hides the report.
 *
 * @param {unknown} value
 * @returns {'text' | 'json'}
 */
function auditFormat(value) {
	return optionalString(value) === 'json' ? 'json' : 'text'
}

/**
 * @returns {object} the `plugin_audit` tool definition
 */
export function createAuditTool() {
	return defineTool({
		name: 'plugin_audit',
		description: [
			'Check a third-party package before installing it into the DSH profile: dist.integrity and shasum against the downloaded tarball, ',
			'install/postinstall scripts, dependency surface, provenance attestations, gitHead presence, engines.dsh / @deepseek-ai/dsh* peer compatibility, ',
			'and version collisions with the current profile. Returns a verdict (allow / block) plus findings that each carry a code, a message and a hint. ',
			'READ-ONLY: it writes no file, installs nothing, runs no package code, and does not spawn npm; the only network use is reading the npm registry ',
			'and the tarball it serves. Not a sandbox: a passing verdict means the supply-chain signals checked out, not that the code is safe. ',
			'Use plugin_doctor for a local bundle directory, and plugin_audit for a registry/git spec you are about to install.',
		].join(''),
		parameters: {
			spec: {
				type: 'string',
				required: true,
				description:
					'Package spec to audit, e.g. lodash@4.17.21, dsh-foo-bar@^0.2, @scope/name@1.0.0-rc.1, github:owner/repo, or ./path. Relative local paths resolve against the host process cwd.',
			},
			registry: {
				type: 'string',
				description: 'Registry base URL; defaults to https://registry.npmjs.org. Point it at a mirror when that is where the package will come from.',
			},
			profileDir: {
				type: 'string',
				description:
					'Profile directory used for the version-collision check. Relative paths resolve against the host process cwd; defaults to the desktop profile.',
			},
			hostVersion: {
				type: 'string',
				description:
					'Running DSH version for the compatibility verdict, e.g. 0.2.1-rc.5. Defaults to DSH_VERSION from the environment; without it the report says compatibility was not checked.',
			},
			format: {
				type: 'string',
				enum: ['text', 'json'],
				description: "Report format: 'text' (default, for reading) or 'json' (the full AuditResult, for scripts). Any other value renders as text.",
			},
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		timeoutMs: 120000,
		// Read-only: no file is written and nothing is mutated, so calls may overlap.
		isConcurrencySafe: () => true,
		async execute(args, ctx) {
			const spec = optionalString(args?.spec)
			if (spec === undefined) {
				return 'plugin_audit: `spec` 不能為空。例如 lodash@4.17.21、github:owner/repo、./path。'
			}

			let pipeline
			try {
				pipeline = await loadAuditModules()
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				return `plugin_audit: 無法載入核查模組（${detail}）。這是外掛本身的問題，不是被核查套件的問題。`
			}

			/** @type {{ registry?: string, profileDir?: string, hostVersion?: string }} */
			const options = {}
			const registry = optionalString(args?.registry)
			if (registry !== undefined) options.registry = registry
			const profileDir = optionalString(args?.profileDir)
			if (profileDir !== undefined) options.profileDir = resolve(process.cwd(), profileDir)
			const hostVersion =
				optionalString(args?.hostVersion) ??
				optionalString(ctx?.hostVersion) ??
				optionalString(process.env.DSH_VERSION)
			if (hostVersion !== undefined) options.hostVersion = hostVersion

			try {
				const result = await pipeline.auditSpec(spec, options)
				return pipeline.renderAuditReport(result, { format: auditFormat(args?.format) })
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				return [
					`plugin_audit: 核查 ${spec} 時發生未預期的錯誤：${detail}`,
					'這是核查工具自身的問題，不能用它判定套件安全與否；請把這行訊息回報，並改用 plugin_doctor 或人工核查。',
				].join('\n')
			}
		},
	})
}

/**
 * @returns {object[]} both tool definitions, in registration order
 */
export function createDevkitTools() {
	return [createScaffoldTool(), createDoctorTool()]
}
