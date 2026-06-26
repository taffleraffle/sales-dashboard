/*
  Editorial state pill for variants. Encodes the Andromeda playbook's
  operational state machine into a visual chip.
*/

const STATE_STYLES = {
  // Live healthy
  winning:      { bg: 'var(--accent-soft)',   fg: 'var(--ink)',   bd: 'var(--accent)',  label: 'Winning',      arrow: '↑' },
  foundational: { bg: 'var(--ink)',            fg: 'var(--paper)', bd: 'var(--ink)',     label: 'Foundational', arrow: '◆' },
  bench:        { bg: 'var(--paper-2)',        fg: 'var(--ink-3)', bd: 'var(--rule)',    label: 'Bench',        arrow: null },
  // Live unhealthy
  bad_pocket:   { bg: 'var(--down-soft)',      fg: 'var(--down)',  bd: 'var(--down)',    label: 'Bad pocket',   arrow: '✗' },
  fatigued:     { bg: 'transparent',           fg: 'var(--ink-3)', bd: 'var(--rule)',    label: 'Fatigued',     arrow: '↓', dashed: true },
  // Authoring states
  concept:       { bg: 'var(--paper-2)',       fg: 'var(--ink-3)', bd: 'var(--rule)',    label: 'Concept',      arrow: null, dashed: true },
  in_production: { bg: 'var(--paper-2)',       fg: 'var(--ink-2)', bd: 'var(--rule)',    label: 'In production', arrow: null, dashed: true },
  ready:         { bg: 'var(--paper-2)',       fg: 'var(--ink-2)', bd: 'var(--rule)',    label: 'Ready',        arrow: null },
  retired:       { bg: 'transparent',          fg: 'var(--ink-4)', bd: 'var(--rule)',    label: 'Retired',      arrow: null },
}

export default function StatePill({ state, size = 'sm' }) {
  const s = STATE_STYLES[state] || STATE_STYLES.bench
  const padding = size === 'lg' ? '4px 11px' : '2px 8px'
  const fontSize = size === 'lg' ? 10.5 : 9.5
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding,
        border: `1px solid ${s.bd}`,
        borderStyle: s.dashed ? 'dashed' : 'solid',
        borderRadius: 9,
        background: s.bg,
        color: s.fg,
        fontFamily: 'var(--mono)',
        fontSize,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {s.arrow && <span style={{ fontSize: fontSize - 1 }}>{s.arrow}</span>}
      {s.label}
    </span>
  )
}
