// Application grading rubric for RankOnMaps prospects.
// Inputs come from GHL custom fields (monthly revenue, price point, monthly calls).
//
// Tier definitions (locked with Daniel):
//   Grade 4: revenue > $150k AND price point > $5k             → priority + best closer
//   Grade 3: revenue $25k–$150k AND price point $500–$5k        → confirm normally
//   Grade 2a: revenue < $25k AND price point >= $500            → double-book
//   Grade 2b: revenue >= $25k AND price point < $500 AND calls > 50  (volume rescue) → double-book
//   Grade 1: everything else (low rev + low price, no volume rescue)  → flag for review

export const GRADE_LABELS = {
  1: { label: 'Grade 1', tone: 'flag',     action: 'Flag for review',       short: 'Flag' },
  2: { label: 'Grade 2', tone: 'caution',  action: 'Double-book this slot', short: 'Double-book' },
  3: { label: 'Grade 3', tone: 'ok',       action: 'Confirm normally',      short: 'Confirm' },
  4: { label: 'Grade 4', tone: 'priority', action: 'Priority + best closer', short: 'Priority' },
}

export function gradeApplication({ monthlyRevenue, pricePoint, monthlyCalls }) {
  const r = Number(monthlyRevenue) || 0
  const p = Number(pricePoint) || 0
  const c = Number(monthlyCalls) || 0

  if (r > 150000 && p > 5000) {
    return { grade: 4, reason: `Revenue $${fmt(r)}/mo + price point $${fmt(p)} — top tier` }
  }
  if (r >= 25000 && r <= 150000 && p >= 500 && p <= 5000) {
    return { grade: 3, reason: `Revenue $${fmt(r)}/mo + price point $${fmt(p)} — fits ICP` }
  }
  if (r < 25000 && p >= 500) {
    return { grade: 2, reason: `Low revenue ($${fmt(r)}/mo) but price point $${fmt(p)} — worth a look` }
  }
  if (r >= 25000 && p < 500 && c > 50) {
    return { grade: 2, reason: `Low ticket ($${fmt(p)}) rescued by ${c} calls/mo + $${fmt(r)} revenue` }
  }
  return { grade: 1, reason: `Low revenue ($${fmt(r)}/mo) + low price point ($${fmt(p)})${c ? ` + only ${c} calls/mo` : ''}` }
}

function fmt(n) {
  if (!n) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}
