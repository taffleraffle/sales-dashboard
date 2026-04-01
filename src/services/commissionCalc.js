/**
 * Determine commission type based on client stage and payment timing.
 * - trial: first payment / trial period
 * - ascension: month 0-3 after trial
 * - recurring: month 3+ ongoing
 */
export function classifyPayment(payment, client) {
  if (!client) return 'trial_close'
  if (payment.payment_type === 'trial' || payment.payment_type === 'one_time') return 'trial_close'
  if (payment.payment_type === 'ascension') return 'ascension'

  // Auto-classify by timing relative to client trial start
  if (client.trial_start_date && client.ascension_date) {
    const paymentDate = new Date(payment.payment_date)
    const ascensionDate = new Date(client.ascension_date)
    const monthsSinceAscension = (paymentDate - ascensionDate) / (30.44 * 86400000)
    if (monthsSinceAscension < 0) return 'trial_close'
    if (monthsSinceAscension < 3) return 'ascension'
    return 'recurring'
  }

  if (client.stage === 'trial') return 'trial_close'
  if (client.stage === 'ascended') return 'ascension'
  return 'recurring'
}

/**
 * Calculate commission entries for a set of payments.
 * Returns commission_ledger rows ready for upsert.
 */
export function calculateCommissions(payments, settingsMap, clientsMap) {
  const entries = []

  for (const payment of payments) {
    if (!payment.matched || !payment.client_id) continue

    const client = clientsMap[payment.client_id]
    if (!client) continue

    const commissionType = classifyPayment(payment, client)
    const period = new Date(payment.payment_date).toISOString().slice(0, 7) // '2026-04'

    // Closer commission
    if (client.closer_id) {
      const settings = settingsMap[client.closer_id]
      if (settings) {
        const rate = commissionType === 'trial_close'
          ? settings.commission_rate
          : settings.ascension_rate || settings.commission_rate
        const amount = payment.net_amount * (rate / 100)
        entries.push({
          member_id: client.closer_id,
          payment_id: payment.id,
          client_id: client.id,
          period,
          commission_type: commissionType,
          payment_amount: payment.net_amount,
          commission_rate: rate,
          commission_amount: Number(amount.toFixed(2)),
          status: 'pending',
        })
      }
    }

    // Setter commission (if attributed)
    if (client.setter_id) {
      const settings = settingsMap[client.setter_id]
      if (settings && settings.commission_rate > 0) {
        const rate = settings.commission_rate
        const amount = payment.net_amount * (rate / 100)
        entries.push({
          member_id: client.setter_id,
          payment_id: payment.id,
          client_id: client.id,
          period,
          commission_type: commissionType,
          payment_amount: payment.net_amount,
          commission_rate: rate,
          commission_amount: Number(amount.toFixed(2)),
          status: 'pending',
        })
      }
    }
  }

  return entries
}

/**
 * Summarize commission ledger entries by member for a period.
 */
export function summarizeCommissions(ledger, settingsMap) {
  const byMember = {}

  for (const entry of ledger) {
    if (!byMember[entry.member_id]) {
      const settings = settingsMap[entry.member_id] || {}
      byMember[entry.member_id] = {
        member_id: entry.member_id,
        base_salary: settings.base_salary || 0,
        trial_commission: 0,
        ascension_commission: 0,
        recurring_commission: 0,
        bonus_commission: 0,
        total_commission: 0,
        total_earnings: 0,
        entries: [],
      }
    }

    const summary = byMember[entry.member_id]
    const amt = Number(entry.commission_amount) || 0

    if (entry.commission_type === 'trial_close') summary.trial_commission += amt
    else if (entry.commission_type === 'ascension') summary.ascension_commission += amt
    else if (entry.commission_type === 'recurring') summary.recurring_commission += amt
    else if (entry.commission_type === 'bonus') summary.bonus_commission += amt

    summary.entries.push(entry)
  }

  // Calculate totals
  for (const m of Object.values(byMember)) {
    m.total_commission = m.trial_commission + m.ascension_commission + m.recurring_commission + m.bonus_commission
    m.total_earnings = m.base_salary + m.total_commission
  }

  return byMember
}
