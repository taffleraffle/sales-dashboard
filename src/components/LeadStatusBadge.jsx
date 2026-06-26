/*
  Editorial lead status badge.
  All statuses use the same .tag base; semantic colour comes from a thin
  border + tinted background derived from the editorial palette.
*/

const statusStyles = {
  set:         { bg: 'var(--paper-2)', fg: 'var(--ink-2)', bd: 'var(--rule)' },
  showed:      { bg: 'var(--accent-soft)', fg: 'var(--ink)', bd: 'var(--accent)' },
  closed:      { bg: 'var(--up-soft)', fg: 'var(--up)', bd: 'var(--up)' },
  no_show:     { bg: 'var(--down-soft)', fg: 'var(--down)', bd: 'var(--down)' },
  not_closed:  { bg: 'var(--paper-2)', fg: 'var(--ink-3)', bd: 'var(--rule)' },
  rescheduled: { bg: '#fff4d6', fg: '#8a5a00', bd: '#d6b876' },
  cancelled:   { bg: 'var(--down-soft)', fg: 'var(--down)', bd: 'var(--down)' },
  ascended:    { bg: '#efe6ff', fg: '#5b3aa3', bd: '#bea7e0' },
}

const statusLabels = {
  set: 'Set',
  showed: 'Showed',
  closed: 'Closed',
  no_show: 'No Show',
  not_closed: 'Not Closed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  ascended: 'Ascended',
}

export default function LeadStatusBadge({ status }) {
  const s = statusStyles[status] || statusStyles.set
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        border: `1px solid ${s.bd}`,
        borderRadius: 9,
        background: s.bg,
        color: s.fg,
        fontFamily: 'var(--mono)',
        fontSize: 9,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {statusLabels[status] || status}
    </span>
  )
}
