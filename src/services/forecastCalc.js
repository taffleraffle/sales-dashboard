/**
 * Backward-funnel forecasting engine for the Closer Forecasting tab.
 *
 * No React, no data fetching — just math, so the page can recompute on every
 * keystroke and the logic stays trivially testable.
 *
 * The funnel, solved backward from a take-home goal:
 *
 *   goal take-home
 *     → commission needed   (honouring base vs ramp)
 *     ÷ commission per close (full lifetime model)
 *     → closes needed
 *     ÷ close rate
 *     → live calls needed
 *     ÷ show rate
 *     → booked calls needed
 *     × cost per booked call
 *     → ad spend needed
 *
 * It also runs FORWARD from the closer's current pace and solves single
 * levers ("what would your close rate need to be?") so the tool answers both
 * "what do I need" and "what if".
 */

const pct = (n) => (Number(n) || 0) / 100
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0)

/**
 * Expected LIFETIME commission a closer earns from ONE new close, modelling
 * the real ledger lifecycle (see services/commissionCalc.js):
 *   - a trial-close commission on the first deal (commission_rate), plus
 *   - for the share that ascend, an ongoing monthly commission at the
 *     ascension_rate for the client's paying lifetime.
 */
export function commissionPerClose(i) {
  const trial = num(i.trialValue) * pct(i.commissionRate)
  const lifetimeMonthly = num(i.monthlyValue) * pct(i.ascensionRate) * num(i.lifetimeMonths)
  const ascended = pct(i.ascendRate) * lifetimeMonthly
  return trial + ascended
}

/**
 * Commission required to reach a take-home target, honouring pay model.
 *   base: take-home = base_salary + commission   → need = target − base
 *   ramp: take-home = max(ramp, commission)      → need = target (only once
 *         the target exceeds the guaranteed ramp floor; below it, the ramp
 *         already covers them so no commission is strictly required).
 */
export function commissionNeededFor(targetTakeHome, i) {
  const T = num(targetTakeHome)
  if (i.payType === 'ramp') {
    const ramp = num(i.rampAmount)
    return T > ramp ? T : 0
  }
  return Math.max(0, T - num(i.baseSalary))
}

/** Take-home a given commission produces under the closer's pay model. */
export function takeHomeFrom(commission, i) {
  const c = num(commission)
  return i.payType === 'ramp'
    ? Math.max(num(i.rampAmount), c)
    : num(i.baseSalary) + c
}

export function forecast(i) {
  const perClose = commissionPerClose(i)
  const commissionNeeded = commissionNeededFor(i.targetTakeHome, i)

  const closesNeeded = perClose > 0 ? commissionNeeded / perClose : Infinity
  const liveCallsNeeded = pct(i.closeRate) > 0 ? closesNeeded / pct(i.closeRate) : Infinity
  const bookedCallsNeeded = pct(i.showRate) > 0 ? liveCallsNeeded / pct(i.showRate) : Infinity
  const adSpendNeeded = Number.isFinite(bookedCallsNeeded) ? bookedCallsNeeded * num(i.costPerBookedCall) : Infinity
  const adSpendByLive = Number.isFinite(liveCallsNeeded) ? liveCallsNeeded * num(i.costPerLiveCall) : Infinity

  // Current pace (the selected window) → implied take-home.
  const currentCloses = num(i.currentCloses)
  const currentCommission = currentCloses * perClose
  const currentTakeHome = takeHomeFrom(currentCommission, i)
  const gapToTarget = num(i.targetTakeHome) - currentTakeHome

  // Single-lever "what would need to change" — hold everything else at the
  // closer's current volume and solve the one knob.
  const currentLive = num(i.currentLiveCalls)
  const currentBooked = num(i.currentBookedCalls)
  const closeRateToHit = currentLive > 0 ? (closesNeeded / currentLive) * 100 : Infinity
  const showRateToHit = currentBooked > 0 ? (liveCallsNeeded / currentBooked) * 100 : Infinity
  const costPerBookedToHit = (Number.isFinite(bookedCallsNeeded) && bookedCallsNeeded > 0 && num(i.adSpendBudget) > 0)
    ? num(i.adSpendBudget) / bookedCallsNeeded
    : null
  const extraLiveCalls = Number.isFinite(liveCallsNeeded) ? liveCallsNeeded - currentLive : Infinity
  const extraBookedCalls = Number.isFinite(bookedCallsNeeded) ? bookedCallsNeeded - currentBooked : Infinity

  // ROAS-ish framing: gross revenue the funnel produces vs the ad spend.
  const grossRevenue = Number.isFinite(closesNeeded)
    ? closesNeeded * (num(i.trialValue) + pct(i.ascendRate) * num(i.monthlyValue) * num(i.lifetimeMonths))
    : Infinity
  const returnOnAdSpend = (Number.isFinite(grossRevenue) && adSpendNeeded > 0) ? grossRevenue / adSpendNeeded : null

  return {
    perClose,
    commissionNeeded,
    closesNeeded,
    liveCallsNeeded,
    bookedCallsNeeded,
    adSpendNeeded,
    adSpendByLive,
    currentCommission,
    currentTakeHome,
    gapToTarget,
    closeRateToHit,
    showRateToHit,
    costPerBookedToHit,
    extraLiveCalls,
    extraBookedCalls,
    grossRevenue,
    returnOnAdSpend,
  }
}
