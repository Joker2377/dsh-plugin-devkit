/**
 * dsh-plugin-devkit — a bundle that helps you build bundles.
 *
 * It registers four host tools:
 *   · plugin_scaffold — write a bundle skeleton that already passes the checks
 *   · plugin_doctor   — read a bundle and report what would stop it installing
 *   · plugin_audit    — read a published package's supply chain before you install it
 *   · plugin_inspect  — compare a profile with what the Host actually loaded
 *
 * Host-only and stateless: no client half, no config, no service of its own. The
 * rules live in pure modules (`scaffold.js`, `checks.js`, `semver.js`,
 * `yaml.js`, `audit.js`) so they are testable without DSH and the CLI can share them.
 *
 * @module dsh-plugin-devkit
 */

import { createAuditTool, createDevkitTools, createInspectTool } from './tools.js'

export const name = 'dsh-plugin-devkit'

/** `ctx.tools` is where the tools go. `loader` is read optionally, so it is not injected. */
export const inject = ['tools']

/**
 * @param {object} ctx Cordis context
 */
export function apply(ctx) {
	const inspect = createInspectTool({ getLoader: () => ctx.get?.('loader') })
	for (const tool of [...createDevkitTools(), createAuditTool(), inspect]) ctx.tools.register(tool)
}
