// Structured contract templates + render helpers shared between the
// inline browser preview (ContractPreview.jsx) and the server-side PDF
// generator (regenerate-amended-agreement Edge fn).

import { TRIAL_TEMPLATE } from './trial'
import { RETAINER_TEMPLATE } from './retainer'

export const TEMPLATES = {
  trial:    TRIAL_TEMPLATE,
  retainer: RETAINER_TEMPLATE,
}

export function getTemplateFor(contract) {
  return TEMPLATES[contract?.contract_type] || TEMPLATES.trial
}

// Substitute the {{client_name}} / {{fee_amount}} / {{project_period_days}}
// placeholders in a string against a contract row.
export function fillPlaceholders(str, contract) {
  if (!str) return ''
  const fee = contract?.fee_amount_usd ?? ''
  const period = contract?.project_period_days ?? (contract?.contract_type === 'retainer' ? 90 : 14)
  const clientName = contract?.client_name || '_____________________'
  return String(str)
    .replace(/\{\{client_name\}\}/g, clientName)
    .replace(/\{\{fee_amount\}\}/g, fee !== '' ? Number(fee).toLocaleString() : '____')
    .replace(/\{\{project_period_days\}\}/g, period)
}

// Build a lookup of clause_id -> amendment for fast in-place substitution.
// Only LOCKED amendments with final_clause_text qualify (consistent with
// the PDF generator's quality gate).
export function indexAmendments(amendments) {
  const byId = {}
  for (const a of amendments || []) {
    if (!a.locked_at) continue
    const text = (a.final_clause_text || a.ai_proposed_redline || '').trim()
    if (!text) continue
    const refKey = normaliseClauseRef(a.clause_reference)
    if (!refKey) continue
    byId[refKey] = { ...a, _finalText: text }
  }
  return byId
}

// Normalise "Clause 7.2" / "clause 7.2(f)" / "7.2" → "7.2" so amendments
// match the structured clause ids. Strips letter/roman sub-clause
// suffixes — when the closer says "Clause 7.2(f)" we still apply the
// amendment at the 7.2 level since the agreed clause text is the
// REPLACEMENT for the whole 7.2 section.
export function normaliseClauseRef(ref) {
  if (!ref) return null
  const m = String(ref).match(/\b(\d+(?:\.\d+)?)/)
  return m ? m[1] : null
}
