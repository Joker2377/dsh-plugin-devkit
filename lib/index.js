/**
 * dsh-plugin-devkit — a bundle that helps you build bundles.
 *
 * It registers two host tools:
 *   · plugin_scaffold — write a bundle skeleton that already passes the checks
 *   · plugin_doctor   — read a bundle and report what would stop it installing
 *
 * Host-only and stateless: no client half, no config, no service of its own. The
 * rules live in pure modules (`scaffold.js`, `checks.js`, `semver.js`,
 * `yaml.js`) so they are testable without DSH and the CLI can share them.
 *
 * @module dsh-plugin-devkit
 */

import { createDevkitTools } from './tools.js'

export const name = 'dsh-plugin-devkit'

/** `ctx.tools` is where the two tools go; nothing else is needed. */
export const inject = ['tools']

/**
 * @param {object} ctx Cordis context
 */
export function apply(ctx) {
	for (const tool of createDevkitTools()) ctx.tools.register(tool)
}
