/*
  In KPI / Marginal / Out of KPI badge for a variant.
  Computed against per-brand thresholds (default v1 fallback if not configured):
    cost_per_booked_call < $200  → in KPI
    cost_per_close       < $2,500
    lead_quality_pct     > 60%
  All three must clear for In KPI; any one marginal drops to Marginal;
  any one failing → Out of KPI.
*/

const DEFAULT_KPI = {
  cpb_in:        200,    // cost per booked call
  cpb_marginal:  300,
  cpc_in:        2500,   // cost per close
  cpc_marginal:  4000,
  lq_in:         60,     // lead quality %
  lq_marginal:   40,
}

export function classifyKPI({ costPerBooked, costPerClose, leadQualityPct, thresholds = DEFAULT_KPI }) {
  const t = thresholds
  const checks = []
  if (costPerBooked != null) {
    checks.push(
      costPerBooked <= t.cpb_in ? 'in' :
      costPerBooked <= t.cpb_marginal ? 'marginal' : 'out'
    )
  }
  if (costPerClose != null) {
    checks.push(
      costPerClose <= t.cpc_in ? 'in' :
      costPerClose <= t.cpc_marginal ? 'marginal' : 'out'
    )
  }
  if (leadQualityPct != null) {
    checks.push(
      leadQualityPct >= t.lq_in ? 'in' :
      leadQualityPct >= t.lq_marginal ? 'marginal' : 'out'
    )
  }
  if (!checks.length) return 'untested'
  if (checks.includes('out')) return 'out'
  if (checks.includes('marginal')) return 'marginal'
  return 'in'
}

const STYLES = {
  in:        { bg: 'var(--up-soft)',   fg: 'var(--up)',   bd: 'var(--up)',    label: 'In KPI' },
  marginal:  { bg: '#fff4d6',          fg: '#8a5a00',     bd: '#d6b876',      label: 'Marginal' },
  out:       { bg: 'var(--down-soft)', fg: 'var(--down)', bd: 'var(--down)',  label: 'Out of KPI' },
  untested:  { bg: 'var(--paper-2)',   fg: 'var(--ink-3)',bd: 'var(--rule)',  label: 'Untested' },
}

export default function KPIBadge({ status }) {
  const s = STYLES[status] || STYLES.untested
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        border: `1px solid ${s.bd}`,
        borderRadius: 2,
        background: s.bg,
        color: s.fg,
        fontFamily: 'var(--mono)',
        fontSize: 9.5,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  )
}
