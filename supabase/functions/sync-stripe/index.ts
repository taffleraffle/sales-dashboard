import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/*
  Advanced Stripe sync — subscription-aware money model.

  ROM sells mostly recurring subscriptions, so this pulls the full billing
  picture, not just charges:
    1. Invoices       -> recurring revenue + AR + failed/dunning, and the
                         native customer_email/customer_name (no customer scope needed)
    2. Charges        -> actual cash collected, fees, net (via balance_transaction)
    3. Subscriptions  -> MRR (normalized to monthly), status, churn
  Then writes a daily MRR snapshot for movement tracking.

  Deliberately does NOT expand `customer`, so it runs on a restricted key that
  lacks Customers-read. Customer emails come from invoices/charges; subscriptions
  inherit the client match via shared customer id. Adding Customers-read later
  only improves matching, nothing breaks without it.

  Multi-account: STRIPE_SECRET_KEY plus STRIPE_SECRET_KEY_2 / _3 ... for each
  account. Optional STRIPE_ACCOUNT_LABELS="primary,coaching,uk".
  Idempotent (upsert on Stripe id). Invoke:  POST /sync-stripe?days=730
*/

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const STRIPE_API = 'https://api.stripe.com/v1'

interface Account { key: string; label: string }

function collectAccounts(): Account[] {
  const labels = (Deno.env.get('STRIPE_ACCOUNT_LABELS') || '').split(',').map(s => s.trim())
  const accounts: Account[] = []
  const primary = Deno.env.get('STRIPE_SECRET_KEY')
  if (primary) accounts.push({ key: primary, label: labels[0] || 'primary' })
  for (let i = 2; i <= 8; i++) {
    const k = Deno.env.get(`STRIPE_SECRET_KEY_${i}`)
    if (k) accounts.push({ key: k, label: labels[i - 1] || `account_${i}` })
  }
  return accounts
}

async function stripeList(key: string, path: string, params: Record<string, string> = {}) {
  const out: Array<Record<string, any>> = []
  let starting_after: string | undefined
  for (let page = 0; page < 300; page++) {
    const qs = new URLSearchParams({ limit: '100', ...params })
    if (starting_after) qs.set('starting_after', starting_after)
    const res = await fetch(`${STRIPE_API}/${path}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) throw new Error(`Stripe ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    const data = json.data || []
    out.push(...data)
    if (!json.has_more || data.length === 0) break
    starting_after = data[data.length - 1].id
  }
  return out
}

const cents = (n: unknown) => (Number(n) || 0) / 100
const iso = (s: unknown) => (s ? new Date((s as number) * 1000).toISOString() : null)

function monthlyize(unitAmount: number, interval: string, intervalCount: number, qty: number): number {
  const per = unitAmount * (qty || 1)
  const n = intervalCount || 1
  switch (interval) {
    case 'year': return per / (12 * n)
    case 'week': return (per * 52) / (12 * n)
    case 'day':  return (per * 365) / (12 * n)
    default:     return per / n
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const accounts = collectAccounts()
    if (accounts.length === 0) {
      return new Response(JSON.stringify({ status: 'skipped', message: 'No STRIPE_SECRET_KEY configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const url = new URL(req.url)
    const days = parseInt(url.searchParams.get('days') || '730')
    const createdGte = Math.floor(Date.now() / 1000) - days * 86400

    // Preload client->stripe_customer linkage once. Matching is in-memory (O(1),
    // no per-row DB or GHL calls) so the backfill finishes inside the function
    // wall-clock. Fuzzy/GHL enrichment is a separate lighter pass, not the sync.
    const { data: clientRows } = await supabase.from('clients').select('id, stripe_customer_id')
    const clientByCustomer = new Map<string, string>()
    for (const c of clientRows || []) if (c.stripe_customer_id) clientByCustomer.set(c.stripe_customer_id as string, c.id as string)
    const resolveClient = (customerId: string | null): string | null =>
      (customerId && clientByCustomer.get(customerId)) || null

    const totals = { subscriptions: 0, invoices: 0, charges: 0, mrr: 0, activeSubs: 0, trialing: 0, pastDue: 0, arOutstanding: 0 }
    const perAccount: Record<string, unknown>[] = []

    for (const acct of accounts) {
      const a = { label: acct.label, subscriptions: 0, invoices: 0, charges: 0, mrr: 0 }
      // customer id -> best known {email, name}, harvested from invoices/charges,
      // then used to match subscriptions without needing Customers-read.
      const custInfo = new Map<string, { email: string | null; name: string | null }>()

      // 1) INVOICES (native customer_email/name) -> revenue + AR
      const invoices = await stripeList(acct.key, 'invoices', { 'created[gte]': String(createdGte) })
      for (const inv of invoices) {
        const custId = (inv.customer as string) || null
        const email = (inv.customer_email as string) || null
        const name = (inv.customer_name as string) || null
        if (custId && (email || name)) custInfo.set(custId, { email, name })
        const clientId = resolveClient(custId)
        const remaining = cents(inv.amount_remaining)
        if (['open', 'uncollectible'].includes(inv.status as string)) totals.arOutstanding += remaining
        await supabase.from('stripe_invoices').upsert({
          id: inv.id, account_label: acct.label,
          subscription_id: (inv.subscription as string) || null,
          stripe_customer_id: custId, client_id: clientId, customer_email: email,
          status: inv.status,
          amount_due: cents(inv.amount_due), amount_paid: cents(inv.amount_paid), amount_remaining: remaining,
          currency: inv.currency || 'usd',
          period_start: iso(inv.period_start), period_end: iso(inv.period_end), due_date: iso(inv.due_date),
          paid_at: iso(inv.status_transitions?.paid_at), attempt_count: Number(inv.attempt_count || 0),
          raw: inv, synced_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        a.invoices++
      }

      // 2) CHARGES -> cash, fees, net
      const charges = await stripeList(acct.key, 'charges', { 'created[gte]': String(createdGte), 'expand[]': 'data.balance_transaction' })
      for (const ch of charges) {
        if (!ch.paid || ch.status !== 'succeeded') continue
        const bt = ch.balance_transaction
        const amount = cents(ch.amount)
        const fee = bt && typeof bt === 'object' ? cents(bt.fee) : Number((amount * 0.029 + 0.30).toFixed(2))
        const net = bt && typeof bt === 'object' ? cents(bt.net) : Number((amount - fee).toFixed(2))
        const email = ch.billing_details?.email || (ch.receipt_email as string) || null
        const name = ch.billing_details?.name || null
        const custId = typeof ch.customer === 'string' ? ch.customer : null
        if (custId && (email || name)) custInfo.set(custId, { email, name })
        const clientId = resolveClient(custId)
        await supabase.from('payments').upsert({
          source: 'stripe', source_event_id: `stripe_${ch.id}`,
          amount, fee, net_amount: net, currency: String(ch.currency || 'usd').toUpperCase(),
          customer_email: email, customer_name: name,
          payment_date: iso(ch.created),
          payment_type: ch.invoice ? 'monthly' : 'one_time',
          description: (ch.description as string) || null,
          stripe_invoice_id: (ch.invoice as string) || null, account_label: acct.label,
          metadata: { charge_id: ch.id }, client_id: clientId, matched: !!clientId,
        }, { onConflict: 'source_event_id' })
        a.charges++
      }

      // 3) SUBSCRIPTIONS -> MRR (match via harvested custInfo)
      const subs = await stripeList(acct.key, 'subscriptions', { status: 'all', 'expand[]': 'data.items.data.price' })
      for (const sub of subs) {
        const custId = (sub.customer as string) || null
        const info = (custId && custInfo.get(custId)) || { email: null, name: null }
        const item = sub.items?.data?.[0] || {}
        const price = item.price || {}
        const rec = price.recurring || {}
        const unit = cents(price.unit_amount)
        const qty = Number(item.quantity || 1)
        const interval = rec.interval || 'month'
        const intervalCount = Number(rec.interval_count || 1)
        const isLive = ['active', 'trialing', 'past_due'].includes(sub.status as string)
        const mrr = isLive ? monthlyize(unit, interval, intervalCount, qty) : 0
        const clientId = resolveClient(custId)

        await supabase.from('stripe_subscriptions').upsert({
          id: sub.id, account_label: acct.label,
          stripe_customer_id: custId, client_id: clientId,
          customer_email: info.email, customer_name: info.name,
          status: sub.status, mrr: Number(mrr.toFixed(2)), currency: price.currency || 'usd',
          interval, interval_count: intervalCount, quantity: qty, unit_amount: unit,
          product_name: typeof price.product === 'object' ? price.product?.name : null,
          plan_nickname: price.nickname || null,
          started_at: iso(sub.start_date), current_period_end: iso(sub.current_period_end),
          trial_end: iso(sub.trial_end), canceled_at: iso(sub.canceled_at),
          raw: sub, synced_at: new Date().toISOString(),
        }, { onConflict: 'id' })

        a.subscriptions++
        if (isLive) a.mrr += mrr
        if (sub.status === 'active') totals.activeSubs++
        if (sub.status === 'trialing') totals.trialing++
        if (sub.status === 'past_due') totals.pastDue++
      }

      totals.subscriptions += a.subscriptions
      totals.invoices += a.invoices
      totals.charges += a.charges
      totals.mrr += a.mrr
      perAccount.push(a)
    }

    const today = new Date().toISOString().split('T')[0]
    await supabase.from('mrr_snapshots').upsert({
      snapshot_date: today, account_label: 'all',
      active_mrr: Number(totals.mrr.toFixed(2)),
      active_subs: totals.activeSubs, trialing_subs: totals.trialing, past_due_subs: totals.pastDue,
      ar_outstanding: Number(totals.arOutstanding.toFixed(2)),
    }, { onConflict: 'snapshot_date,account_label' })

    return new Response(JSON.stringify({ status: 'ok', accounts: accounts.length, totals, perAccount }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
