// ContractPreview — inline HTML rendering of a structured contract
// with locked amendments substituted IN PLACE within their natural
// clause position. Replaces the PDF iframe in the right pane.
//
// How amendment substitution works:
//   1. Walk the structured template clause-by-clause
//   2. For each top-level clause, check if there's a locked amendment
//      with a clause_reference that matches the clause number
//   3. If yes, render the new agreed text in a yellow-highlighted
//      block IN PLACE of the original clause body (header stays).
//      Optionally show the original underneath the new in collapsed
//      "previously read" form when the closer captured it.
//   4. If no, render the original clause as-is.

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { getTemplateFor, fillPlaceholders, indexAmendments, normaliseClauseRef } from '../../data/contracts'

export default function ContractPreview({ contract, amendments }) {
  const template = useMemo(() => getTemplateFor(contract), [contract])
  const amendmentsByClause = useMemo(() => indexAmendments(amendments), [amendments])
  const amendedCount = Object.keys(amendmentsByClause).length

  return (
    <div className="contract-preview" style={{ background: 'var(--paper)', padding: '24px 28px', fontFamily: 'var(--serif)', color: 'var(--ink)', lineHeight: 1.6 }}>
      {amendedCount > 0 && (
        <div className="mb-5 p-3" style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: 9 }}>
          <p style={{ margin: 0, fontSize: 12, fontFamily: 'var(--sans, Inter)', color: 'var(--ink-2)' }}>
            <strong>{amendedCount}</strong> clause{amendedCount === 1 ? '' : 's'} amended.
            {' '}Amended clauses are shown in yellow at their natural position in the document.
          </p>
        </div>
      )}

      {/* CLIENT FORM section */}
      <ClientFormSection template={template} contract={contract} />

      {/* CLIENT TERMS preamble */}
      <h2 style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: '0.18em', textTransform: 'uppercase', marginTop: 28, marginBottom: 8, color: 'var(--ink)' }}>
        {template.preamble.title}
      </h2>
      <p style={{ fontSize: 12.5, marginTop: 0, marginBottom: 16 }}>{template.preamble.intro}</p>

      {/* CLAUSES */}
      {template.clauses.map(clause => (
        <ClauseBlock
          key={clause.id}
          clause={clause}
          amendment={amendmentsByClause[clause.id]}
          subAmendments={amendmentsByClause}
        />
      ))}
    </div>
  )
}

function ClientFormSection({ template, contract }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: '0.18em', textTransform: 'uppercase', marginTop: 0, marginBottom: 12, color: 'var(--ink)' }}>
        CLIENT FORM
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 18, fontFamily: 'var(--sans, Inter)' }}>
        <tbody>
          {template.clientForm.rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--rule)' }}>
              <td style={{ padding: '6px 12px 6px 0', verticalAlign: 'top', color: 'var(--ink-2)', width: '38%', whiteSpace: 'nowrap' }}>
                {row.label}
              </td>
              <td style={{ padding: '6px 0', verticalAlign: 'top', whiteSpace: 'pre-line' }}>
                {fillPlaceholders(row.value, contract)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {template.clientForm.declarations.map((p, i) => (
        <p key={i} style={{ fontSize: 12.5, marginTop: 0, marginBottom: 10 }}>{fillPlaceholders(p, contract)}</p>
      ))}
      <p style={{ fontSize: 12.5, marginTop: 12, marginBottom: 4, fontStyle: 'italic', color: 'var(--ink-2)' }}>
        {template.clientForm.executionLine}
      </p>
    </div>
  )
}

function ClauseBlock({ clause, amendment, subAmendments }) {
  // Section is "touched" by an amendment if either the top-level clause
  // itself was amended OR any of its sub-sections were. We add a tinted
  // background + yellow left rule to the whole section in that case so
  // the closer's eye lands on it when scrolling.
  const subAmendedIds = clause.sections
    ? clause.sections.filter(sec => subAmendments[sec.id]).map(sec => sec.number)
    : []
  const isTouched = !!amendment || subAmendedIds.length > 0

  return (
    <section
      id={`clause-${clause.id}`}
      style={{
        marginBottom: 18,
        scrollMarginTop: 16,
        ...(isTouched && {
          padding: '12px 14px',
          background: 'rgba(244, 225, 74, 0.06)',
          borderLeft: '3px solid var(--accent)',
          borderRadius: 9,
        }),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <h3 style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '0.16em', textTransform: 'uppercase', margin: 0, color: 'var(--ink)' }}>
          {clause.number}.&nbsp;&nbsp;{clause.title}
        </h3>
        {isTouched && <AmendedBadge count={amendment ? 1 : subAmendedIds.length} />}
      </div>

      {amendment ? (
        <AmendedClauseBody amendment={amendment} originalClause={clause} />
      ) : clause.sections ? (
        clause.sections.map(sec => {
          const subAmendment = subAmendments[sec.id]
          return (
            <SubSection key={sec.id} section={sec} amendment={subAmendment} />
          )
        })
      ) : (
        <ParagraphList clause={clause} />
      )}
    </section>
  )
}

function AmendedBadge({ count }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      background: 'var(--accent)',
      color: 'var(--ink)',
      fontFamily: 'var(--mono)',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      borderRadius: 9,
      flexShrink: 0,
    }}>
      ★ Amended{count > 1 ? ` (${count})` : ''}
    </span>
  )
}

function SubSection({ section, amendment }) {
  return (
    <section id={`clause-${section.id}`} style={{ marginBottom: 14, marginLeft: 4, scrollMarginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8, marginBottom: 6 }}>
        <h4 style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', margin: 0, color: amendment ? 'var(--ink)' : 'var(--ink-2)', fontWeight: amendment ? 700 : 500 }}>
          {section.number}&nbsp;&nbsp;{section.title}
        </h4>
        {amendment && <AmendedBadge count={1} />}
      </div>
      {amendment ? (
        <AmendedClauseBody amendment={amendment} originalClause={section} />
      ) : (
        <ParagraphList clause={section} />
      )}
    </section>
  )
}

function ParagraphList({ clause }) {
  return (
    <>
      {clause.intro && (
        <p style={{ fontSize: 12.5, marginTop: 0, marginBottom: 6 }}>{clause.intro}</p>
      )}
      {(clause.paragraphs || []).map((p, i) => (
        <Paragraph key={i} para={p} />
      ))}
    </>
  )
}

function Paragraph({ para, depth = 0 }) {
  return (
    <>
      <p style={{ fontSize: 12.5, marginTop: 0, marginBottom: 4, marginLeft: depth * 18, display: 'flex', gap: 8 }}>
        {para.label && <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, flexShrink: 0, color: 'var(--ink-2)' }}>{para.label}</span>}
        <span style={{ flex: 1 }}>{para.text}</span>
      </p>
      {para.children && para.children.map((c, i) => (
        <Paragraph key={i} para={c} depth={depth + 1} />
      ))}
    </>
  )
}

// AmendedClauseBody — renders the new agreed language in a filled yellow
// block. If the closer captured the original_excerpt, show it collapsed
// at the top of the block so the change is legible side-by-side.
function AmendedClauseBody({ amendment, originalClause }) {
  const [showOriginal, setShowOriginal] = useState(false)
  return (
    <div style={{
      background: 'var(--accent-soft)',
      border: '2px solid var(--accent)',
      borderLeft: '5px solid var(--accent)',
      padding: '14px 16px',
      borderRadius: 9,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-2)' }}>
          ★ AMENDED CLAUSE
        </span>
        <button
          type="button"
          onClick={() => setShowOriginal(s => !s)}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-2)',
            padding: 0,
          }}
        >
          {showOriginal ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          Original text
        </button>
      </div>

      {showOriginal && (
        <div style={{ padding: '8px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 9, marginBottom: 10, fontSize: 11.5, fontStyle: 'italic', color: 'var(--ink-3)' }}>
          {amendment.original_excerpt ? (
            <p style={{ margin: 0, whiteSpace: 'pre-line' }}>"{amendment.original_excerpt}"</p>
          ) : (
            <OriginalClausePreview clause={originalClause} />
          )}
        </div>
      )}

      <div style={{
        fontSize: 13,
        lineHeight: 1.65,
        fontFamily: 'var(--serif)',
        fontWeight: 600,
        color: 'var(--ink)',
        whiteSpace: 'pre-line',
      }}>
        {amendment._finalText}
      </div>

      {amendment.locked_at && (
        <p style={{ marginTop: 10, marginBottom: 0, fontSize: 10, fontFamily: 'var(--mono)', fontStyle: 'italic', color: 'var(--ink-3)' }}>
          Agreed {new Date(amendment.locked_at).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland' })}
        </p>
      )}
    </div>
  )
}

// Quietly render the unmodified clause text as the "Original" peek when
// no explicit original_excerpt was captured.
function OriginalClausePreview({ clause }) {
  if (!clause) return null
  if (clause.paragraphs) {
    return (
      <>
        {clause.intro && <p style={{ margin: '0 0 4px' }}>{clause.intro}</p>}
        {clause.paragraphs.map((p, i) => (
          <p key={i} style={{ margin: '0 0 3px', display: 'flex', gap: 6 }}>
            {p.label && <span style={{ flexShrink: 0 }}>{p.label}</span>}
            <span>{p.text}</span>
          </p>
        ))}
      </>
    )
  }
  if (clause.sections) {
    return clause.sections.map(sec => (
      <div key={sec.id} style={{ marginTop: 4 }}>
        <p style={{ margin: '0 0 2px', fontWeight: 600 }}>{sec.number} {sec.title}</p>
        <OriginalClausePreview clause={sec} />
      </div>
    ))
  }
  return null
}
