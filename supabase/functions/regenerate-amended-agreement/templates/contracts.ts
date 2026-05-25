// Structured contract templates + render helpers shared between the
// inline browser preview (ContractPreview.jsx) and the server-side PDF
// generator (regenerate-amended-agreement Edge fn).

// @ts-ignore — Deno resolves .ts modules with explicit extensions
import { TRIAL_TEMPLATE } from './trial-structured.ts'
// @ts-ignore
import { RETAINER_TEMPLATE } from './retainer-structured.ts'

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

// Build a lookup of clause_id -> amendment. Supports both single-clause
// amendments (one clause_reference field) and multi-clause amendments
// where the closer bundled multiple clause changes inside a single
// final_clause_text using "CLAUSE X.X AMENDMENT" headers as delimiters.
// See src/data/contracts/index.js for the canonical comment.
const MULTI_HEADER_RE = /^\s*CLAUSE\s+(\d+(?:\.\d+)?)\s+AMENDMENT\b[^\n]*/gim

export function indexAmendments(amendments) {
  const byId = {}
  for (const a of amendments || []) {
    if (!a.locked_at) continue
    const text = (a.final_clause_text || a.ai_proposed_redline || '').trim()
    if (!text) continue
    const segments = splitByClauseHeaders(text)
    if (segments.length > 0) {
      for (const seg of segments) {
        byId[seg.clauseId] = { ...a, _finalText: seg.text, _segment: true }
      }
    } else {
      const refKey = normaliseClauseRef(a.clause_reference)
      if (refKey) byId[refKey] = { ...a, _finalText: text }
    }
  }
  return byId
}

export function splitByClauseHeaders(text) {
  if (!text) return []
  const matches = [...text.matchAll(MULTI_HEADER_RE)]
  if (matches.length === 0) return []
  const segments = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = m.index
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length
    const segText = text.slice(start, end).trim()
    const body = segText.replace(MULTI_HEADER_RE, '').replace(/^\s*[-=_]{3,}\s*$/gm, '').trim()
    if (body) segments.push({ clauseId: m[1], text: body })
  }
  return segments
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
