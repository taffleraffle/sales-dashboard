import { supabase } from '../lib/supabase'

/**
 * Normalize a name for fuzzy matching:
 * - Lowercase, trim
 * - Strip common suffixes like "- RestorationConnect Strategy Call"
 * - Extract just the person's name
 */
function normalizeName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .trim()
    .replace(/\s*[-–—]\s*(restoration|plumber|remodel|service|pool)connect.*$/i, '')
    .replace(/\s*[-–—]\s*(strategy|intro).*call.*$/i, '')
    .replace(/\s+x\s+daniel\b.*/i, '')  // "Jesus x Daniel Remodeling..."
    .replace(/\s*[-–—]\s*remodeling ai.*$/i, '')
    .trim()
}

function firstName(name) {
  return normalizeName(name).split(/\s+/)[0] || ''
}

/**
 * Auto-reconcile closer_calls with setter_leads.
 *
 * For each unlinked closer_call, tries to find a matching setter_lead by:
 * 1. First name match within ±3 days of appointment
 * 2. Full name substring match
 *
 * When matched:
 * - Sets closer_calls.setter_lead_id
 * - Updates setter_leads.status, revenue_attributed, closer_id
 *
 * @param {string|null} dateStr - If provided, only reconcile for this date. Otherwise all time.
 * @returns {{ matched: number, unmatched: number }}
 */
export async function reconcileAttribution(dateStr = null) {
  // 1. Fetch unlinked closer_calls
  let callQuery = supabase
    .from('closer_calls')
    .select('id, prospect_name, outcome, revenue, cash_collected, eod_report_id')
    .is('setter_lead_id', null)
    .in('outcome', ['closed', 'not_closed', 'no_show', 'rescheduled', 'ascended'])

  const { data: calls } = await callQuery

  if (!calls?.length) return { matched: 0, unmatched: 0 }

  // Get report dates for these calls
  const reportIds = [...new Set(calls.map(c => c.eod_report_id))]
  const { data: reports } = await supabase
    .from('closer_eod_reports')
    .select('id, report_date, closer_id')
    .in('id', reportIds)
  const reportMap = {}
  for (const r of (reports || [])) reportMap[r.id] = r

  // 2. Fetch setter_leads that could be matched
  let leadQuery = supabase
    .from('setter_leads')
    .select('id, lead_name, setter_id, appointment_date, date_set, status')

  if (dateStr) {
    // For a specific date, look at leads with appointment within ±3 days
    const d = new Date(dateStr + 'T00:00:00')
    const before = new Date(d); before.setDate(before.getDate() - 3)
    const after = new Date(d); after.setDate(after.getDate() + 3)
    const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
    leadQuery = leadQuery.gte('appointment_date', fmt(before)).lte('appointment_date', fmt(after))
  }

  const { data: leads } = await leadQuery
  if (!leads?.length) return { matched: 0, unmatched: calls.length }

  // Build lead lookup by first name
  const leadsByFirstName = {}
  for (const lead of leads) {
    const fn = firstName(lead.lead_name)
    if (fn.length < 2) continue
    if (!leadsByFirstName[fn]) leadsByFirstName[fn] = []
    leadsByFirstName[fn].push(lead)
  }

  let matched = 0, unmatched = 0
  const usedLeadIds = new Set()

  for (const call of calls) {
    const report = reportMap[call.eod_report_id]
    if (!report) { unmatched++; continue }

    const callFirstName = firstName(call.prospect_name)
    const callNorm = normalizeName(call.prospect_name)
    const reportDate = report.report_date

    // Try first name match
    let bestMatch = null
    const candidates = leadsByFirstName[callFirstName] || []

    for (const lead of candidates) {
      if (usedLeadIds.has(lead.id)) continue

      // Check date proximity (appointment_date within ±3 days of report_date)
      if (lead.appointment_date && reportDate) {
        const apptDate = new Date(lead.appointment_date + 'T00:00:00')
        const rptDate = new Date(reportDate + 'T00:00:00')
        const daysDiff = Math.abs((apptDate - rptDate) / 86400000)
        if (daysDiff <= 3) {
          bestMatch = lead
          break
        }
      }

      // Fallback: full name substring match (no date constraint)
      const leadNorm = normalizeName(lead.lead_name)
      if (callNorm.includes(leadNorm) || leadNorm.includes(callNorm)) {
        bestMatch = lead
      }
    }

    // Also try full name matching across ALL leads if first name didn't work
    if (!bestMatch && callNorm.length > 3) {
      for (const lead of leads) {
        if (usedLeadIds.has(lead.id)) continue
        const leadNorm = normalizeName(lead.lead_name)
        if (leadNorm.length < 3) continue

        // Check if names overlap significantly
        const callParts = callNorm.split(/\s+/)
        const leadParts = leadNorm.split(/\s+/)
        const matchingParts = callParts.filter(p => p.length > 2 && leadParts.some(lp => lp === p))
        if (matchingParts.length >= 1 && matchingParts.length >= Math.min(callParts.length, leadParts.length) * 0.5) {
          // Date check
          if (lead.appointment_date && reportDate) {
            const daysDiff = Math.abs((new Date(lead.appointment_date + 'T00:00:00') - new Date(reportDate + 'T00:00:00')) / 86400000)
            if (daysDiff <= 5) {
              bestMatch = lead
              break
            }
          }
        }
      }
    }

    if (bestMatch) {
      usedLeadIds.add(bestMatch.id)

      // Map ascension outcomes to standard setter_leads statuses
      const statusMap = { ascended: 'closed', closed: 'closed', not_closed: 'not_closed', no_show: 'no_show', rescheduled: 'rescheduled' }
      const newStatus = statusMap[call.outcome] || call.outcome

      // Update closer_calls with the link
      await supabase
        .from('closer_calls')
        .update({ setter_lead_id: bestMatch.id })
        .eq('id', call.id)

      // Update setter_leads with outcome
      await supabase
        .from('setter_leads')
        .update({
          status: newStatus,
          revenue_attributed: parseFloat(call.revenue || 0),
          closer_id: report.closer_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bestMatch.id)

      matched++
    } else {
      unmatched++
    }
  }

  return { matched, unmatched }
}
