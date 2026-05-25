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

// Build a lookup of clause_id -> { amendment, text } for fast in-place
// substitution. Handles two shapes:
//
//   1) Single-clause amendment: one amendment row, one clause_reference
//      (e.g. "Clause 19.1"), one final_clause_text. Indexed at the
//      normalised clause id.
//
//   2) Multi-clause amendment: one amendment row, but the closer bundled
//      multiple clause changes inside a single final_clause_text using
//      "CLAUSE X.X AMENDMENT" headers as delimiters (which the judge is
//      instructed to do via the system prompt). We split on those
//      headers and index each segment at its own clause id. This is how
//      Eric1's IP Vesting (12.2) + Direct Debit Removal (7.2) lock
//      lands TWO substitutions from a single amendment row.
//
// Only LOCKED amendments with non-empty agreed text qualify.
const MULTI_HEADER_RE = /^\s*CLAUSE\s+(\d+(?:\.\d+)?)\s+AMENDMENT\b[^\n]*/gim

export function indexAmendments(amendments) {
  const byId = {}
  for (const a of amendments || []) {
    if (!a.locked_at) continue
    const text = (a.final_clause_text || a.ai_proposed_redline || '').trim()
    if (!text) continue

    const segments = splitByClauseHeaders(text)
    if (segments.length > 0) {
      // Multi-clause path: one entry per CLAUSE X.X AMENDMENT block
      for (const seg of segments) {
        byId[seg.clauseId] = { ...a, _finalText: seg.text, _segment: true }
      }
    } else {
      // Single-clause path: fall back to clause_reference field
      const refKey = normaliseClauseRef(a.clause_reference)
      if (refKey) {
        byId[refKey] = { ...a, _finalText: text }
      }
    }
  }
  return byId
}

// Split a locked amendment text by "CLAUSE X.X AMENDMENT" headers.
// Returns [] when no headers are found (caller falls back to single-clause
// mode). Returns [{ clauseId, text }] one entry per segment otherwise.
// The text per segment INCLUDES the header line so the PDF/preview can
// render it for context (closer-facing legal title).
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
    // Strip the leading header line from the rendered text — the clause
    // header is already drawn by the renderer separately, no need to
    // duplicate it inside the yellow block.
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
