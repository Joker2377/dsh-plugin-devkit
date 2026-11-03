/**
 * Render an audit as the text a reader follows, or as machine JSON.
 *
 * The first three lines are fixed so the report can be skimmed: what was
 * audited, the verdict, then what was actually checked. Findings follow in
 * severity order, and the last line says what to do next.
 *
 * @module dsh-plugin-devkit/audit-report
 */

const MARK = { error: '✗', warn: '⚠', info: '·' }
const LEVEL_ORDER = { error: 0, warn: 1, info: 2 }

/**
 * Errors first, warnings next, notes last; same-level findings keep step order.
 *
 * @param {object} result output of `auditSpec()`
 * @returns {Array<object>}
 */
function sortedFindings(result) {
	const findings = Array.isArray(result?.findings) ? [...result.findings] : []
	return findings.sort((left, right) => (LEVEL_ORDER[left.level] ?? 9) - (LEVEL_ORDER[right.level] ?? 9))
}

/**
 * @param {string[] | undefined} checked
 * @returns {string}
 */
function checkedLabel(checked) {
	return Array.isArray(checked) && checked.length > 0 ? checked.join(', ') : '（無）'
}

/**
 * @param {object} result output of `auditSpec()`
 * @returns {string}
 */
function nextStep(result) {
	if (result?.verdict?.install === 'block') {
		return '下一步：先解決 error；供應鏈核查未過就不安裝。'
	}
	if (result?.verdict?.install === 'not-audited') {
		return '下一步：這份 spec 沒有跑 registry 側檢查，不能當成通過；要核查請指向已發佈版本，或用 plugin_doctor 檢查目錄。'
	}
	if ((result?.counts?.warn ?? 0) > 0) {
		return '下一步：可以安裝，但先看過 warn；那幾項是判斷依據，不是自動阻擋。'
	}
	return '下一步：可以直接安裝；安裝後用 plugin_doctor 確認載入正常。'
}

/**
 * @param {{ install?: string, reason?: string }} verdict
 * @returns {string} the second line of the text report
 */
function conclusionLine(verdict) {
	if (verdict.install === 'allow') return '結論：可以安裝'
	if (verdict.install === 'not-audited') return `結論：未核查 — ${verdict.reason ?? '沒有執行 registry 側檢查'}`
	return `結論：不可以安裝 — ${verdict.reason ?? '有 error 級 finding'}`
}

/**
 * @param {object} result output of `auditSpec()`
 * @param {Array<object>} findings severity-ordered findings
 * @returns {string}
 */
function renderText(result, findings) {
	const counts = result?.counts ?? { error: 0, warn: 0, info: 0 }
	const verdict = result?.verdict ?? { install: 'block', reason: '沒有結論' }
	const spec = result?.target?.spec ?? ''
	const lines = [
		`plugin_audit ${spec}`,
		conclusionLine(verdict),
		`${counts.error} error · ${counts.warn} warn · ${counts.info} info · 已檢查：${checkedLabel(verdict.checked)}`,
	]

	if (findings.length > 0) {
		lines.push('')
		for (const finding of findings) {
			lines.push(`${MARK[finding.level] ?? '·'} [${finding.code}] ${finding.message}`)
			if (finding.hint !== undefined) lines.push(`   → ${finding.hint}`)
		}
	}

	lines.push('', nextStep(result))
	return lines.join('\n')
}

/**
 * @param {object} result output of `auditSpec()`
 * @param {Array<object>} findings severity-ordered findings
 * @returns {object}
 */
function toJson(result, findings) {
	const counts = result?.counts ?? { error: 0, warn: 0, info: 0 }
	const verdict = result?.verdict ?? { install: 'block', blocking: [], reason: '', checked: [] }
	return {
		spec: result?.target?.spec ?? '',
		ok: result?.ok === true,
		target: result?.target ?? {},
		verdict: {
			install: verdict.install,
			blocking: Array.isArray(verdict.blocking) ? [...verdict.blocking] : [],
			reason: verdict.reason ?? '',
			checked: Array.isArray(verdict.checked) ? [...verdict.checked] : [],
		},
		counts: { error: counts.error, warn: counts.warn, info: counts.info },
		findings: findings.map((finding) => {
			const copy = { level: finding.level, code: finding.code, message: finding.message }
			if (finding.hint !== undefined) copy.hint = finding.hint
			if (finding.evidence !== undefined) copy.evidence = finding.evidence
			return copy
		}),
		evidence: result?.evidence ?? {},
	}
}

/**
 * @param {object} result output of `auditSpec()`
 * @param {{ format?: 'text' | 'json' }} [options]
 * @returns {string}
 */
export function renderAuditReport(result, options = {}) {
	const format = options?.format ?? 'text'
	const findings = sortedFindings(result)
	if (format === 'json') return JSON.stringify(toJson(result, findings), null, 2)
	return renderText(result, findings)
}

/**
 * One line for logs and CI output.
 *
 * @param {object} result output of `auditSpec()`
 * @returns {string}
 */
export function auditSummaryLine(result) {
	const counts = result?.counts ?? { error: 0, warn: 0, info: 0 }
	const verdict = result?.verdict ?? { install: 'block', blocking: [] }
	const head = verdict.install === 'allow' ? 'ALLOW' : verdict.install === 'not-audited' ? 'NOT-AUDITED' : 'BLOCK'
	const line = `${head} ${counts.error} error ${counts.warn} warn ${counts.info} info`
	const blocking = Array.isArray(verdict.blocking) ? verdict.blocking : []
	return blocking.length > 0 ? `${line} — ${blocking.join(', ')}` : line
}
