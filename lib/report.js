/**
 * Render a diagnosis as the text a reader sees.
 *
 * Errors first, then warnings, then notes, each with the code to grep for and the
 * concrete way out. A report that ends on "0 error" says so once, plainly.
 *
 * @module dsh-plugin-devkit/report
 */

const MARK = { error: '✗', warn: '⚠', info: '·' }

/**
 * @param {object} result output of `diagnose()`
 * @param {{ root?: string, hostVersion?: string }} [context]
 * @returns {string}
 */
export function renderReport(result, context = {}) {
	const { root, hostVersion } = context
	const lines = [`plugin_doctor${root === undefined ? '' : ` ${root}`}`]
	lines.push(hostVersion === undefined ? 'host: （未提供，略過相容性判定）' : `host: ${hostVersion}`)
	lines.push('')

	const { counts } = result
	lines.push(`${result.ok ? '通過' : '未通過'}：${counts.error} error · ${counts.warn} warn · ${counts.info} info`)

	if (result.findings.length === 0) {
		lines.push('', '沒有發現問題。')
		return lines.join('\n')
	}

	lines.push('')
	for (const finding of result.findings) {
		lines.push(`${MARK[finding.level]} [${finding.code}] ${finding.message}`)
		if (finding.hint !== undefined) lines.push(`   → ${finding.hint}`)
	}
	return lines.join('\n')
}

/**
 * One line for logs and CI output.
 *
 * @param {object} result output of `diagnose()`
 * @returns {string}
 */
export function summaryLine(result) {
	const { error, warn, info } = result.counts
	return `${result.ok ? 'OK' : 'FAIL'} ${error} error ${warn} warn ${info} info`
}
