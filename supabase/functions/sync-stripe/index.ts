import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchPaymentToClient } from '../_shared/matchPayment.ts'

/*
  Advanced Stripe sync — subscription-aware money model.

  ROM sells mostly recurring subscriptions, so this pulls the full billing
  picture, not just charges:
    1. Subscriptions  -> MRR (normalized to monthly), status, churn
    2. Invoices       -> recurring revenue recognized + AR + failed/dunning
    3. Charges        -> actual cash collected, fees, net (via balance_transaction)
  Then writes a daily MRR snapshot for movement tracking.

  Multi-account: set STRIPE_SECRET_KEY plus STRIPE_SECRET_KEY_2 / _3 / _4 for
  each Stripe account. Optional STRIPE_ACCOUNT_LABELS="primary,coaching,uk".
  Read-only restricted keys are expected (rk_live_...).

  Idempotent: every object upserts on its Stripe id, so re-running backfills
  safely. Invoke:  POST /sync-stripe?days=730
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

// Paginate any Stripe list endpoint, following has_more via starting_after.
async function stripeList(key: string, path: string, params: Record<string, string> = {}) {
  const out: Array<Record<string, unknown>> = []
  let starting_after: string | undefined
  for (let page = 0; page < 200; page++) {
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

// Normalize any recurring price to monthly recurring revenue (major units).
function monthlyize(unitAmount: number, interval: string, intervalCount: number, qty: number): number {
  const per = unitAmount * (qty || 1)
  const n = intervalCount || 1
  switch (interval) {
    case 'year':  return per / (12 * n)
    case 'week':  return (per * 52) / (12 * n)
    case 'day':   return (per * 365) / (12 * n)
    case 'month':
    default:      return per / n
  }
}

function custOf(obj: Record<string, any>) {
  const c = obj.customer
  if (c && typeof c === 'object') return { id: c.id as string, email: c.email as string, name: c.name as string }
  return { id: (typeof c === 'string' ? c : null) as string | null, email: null, name: null }
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
    const ghlApiKey = Deno.env.get('GHL_API_KEY') || ''
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID') || ''

    const url = new URL(req.url)
    const days = parseInt(url.searchParams.get('days') || '730')
    const createdGte = Math.floor(Date.now() / 1000) - days * 86400

    // Resolve a Stripe customer to a ROM client: prefer the stored stripe_customer_id,
    // else fall back to fuzzy email/name match (and cache the id for next time).
    const clientCache = new Map<string, string | null>()
    async function resolveClient(customerId: string | null, email: string | null, name: string | null): Promise<string | null> {
      if (customerId && clientCache.has(customerId)) return clientCache.get(customerId)!
      let clientId: string | null = null
      if (customerId) {
        const { data } = await supabase.from('clients').select('id').eq('stripe_customer_id', customerId).limit(1).maybeSingle()
        clientId = data?.id || null
      }
      if (!clientId && (email || name)) {
        const m = await matchPaymentToClient(supabase, email, null, name, ghlApiKey, ghlLocationId)
        clientId = m.clientId || null
        if (clientId && customerId) await supabase.from('clients').update({ stripe_customer_id: customerId }).eq('id', clientId)
      }
      if (customerId) clientCache.set(customerId, clientId)
      return clientId
    }

    const totals = { subscriptions: 0, invoices: 0, charges: 0, mrr: 0, activeSubs: 0, trialing: 0, pastDue: 0, arOutstanding: 0 }
    const perAccount: Record<string, unknown>[] = []

    for (const acct of accounts) {
      const a = { label: acct.label, subscriptions: 0, invoices: 0, charges: 0, mrr: 0, activeSubs: 0 }

      // 1) SUBSCRIPTIONS -> MRR
      const subs = await stripeList(acct.key, 'subscriptions', {
        status: 'all',
        'expand[]': 'data.customer',
      })
      // second expand has to be on the same call; Stripe allows multiple expand[]:
      // we refetch items.price.product inline below if missing.
      for (const sub of subs) {
        const cu = custOf(sub)
        const item = (sub.items as any)?.data?.[0] || {}
        const price = item.price || {}
        const rec = price.recurring || {}
        const unit = cents(price.unit_amount)
        const qty = Number(item.quantity || 1)
        const interval = rec.interval || 'month'
        const intervalCount = Number(rec.interval_count || 1)
        const isLive = ['active', 'trialing', 'past_due'].includes(sub.status as string)
        const mrr = isLive ? monthlyize(unit, interval, intervalCount, qty) : 0
        const clientId = await resolveClient(cu.id, cu.email, cu.name)

        await supabase.from('stripe_subscriptions').upsert({
          id: sub.id, account_label: acct.label,
          stripe_customer_id: cu.id, client_id: clientId,
          customer_email: cu.email, customer_name: cu.name,
          status: sub.status, mrr: Number(mrr.toFixed(2)),
          currency: price.currency || 'usd',
          interval, interval_count: intervalCount, quantity: qty, unit_amount: unit,
          product_name: typeof price.product === 'object' ? price.product?.name : null,
          plan_nickname: price.nickname || null,
          started_at: sub.start_date ? new Date((sub.start_date as number) * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date((sub.current_period_end as number) * 1000).toISOString() : null,
          trial_end: sub.trial_end ? new Date((sub.trial_end as number) * 1000).toISOString() : null,
          canceled_at: sub.canceled_at ? new Date((sub.canceled_at as number) * 1000).toISOString() : null,
          raw: sub, synced_at: new Date().toISOString(),
        }, { onConflict: 'id' })

        a.subscriptions++
        if (isLive) { a.mrr += mrr; a.activeSubs += (sub.status === 'active' ? 1 : 0) }
        if (sub.status === 'active') totals.activeSubs++
        if (sub.status === 'trialing') totals.trialing++
        if (sub.status === 'past_due') totals.pastDue++
      }

      // 2) INVOICES -> recurring revenue + AR + failed
      const invoices = await stripeList(acct.key, 'invoices', {
        'created[gte]': String(createdGte),
        'expand[]': 'data.customer',
      })
      for (const inv of invoices) {
        const cu = custOf(inv)
        const clientId = await resolveClient(cu.id, cu.email, cu.name)
        const remaining = cents(inv.amount_remaining)
        if (['open', 'uncollectible'].includes(inv.status as string)) totals.arOutstanding += remaining
        await supabase.from('stripe_invoices').upsert({
          id: inv.id, account_label: acct.label,
          subscription_id: (inv.subscription as string) || null,
          stripe_customer_id: cu.id, client_id: clientId, customer_email: cu.email,
          status: inv.status,
          amount_due: cents(inv.amount_due), amount_paid: cents(inv.amount_paid), amount_remaining: remaining,
          currency: inv.currency || 'usd',
          period_start: inv.period_start ? new Date((inv.period_start as number) * 1000).toISOString() : null,
          period_end: inv.period_end ? new Date((inv.period_end as number) * 1000).toISOString() : null,
          due_date: inv.due_date ? new Date((inv.due_date as number) * 1000).toISOString() : null,
          paid_at: inv.status_transitions?.paid_at ? new Date((inv.status_transitions.paid_at as number) * 1000).toISOString() : null,
          attempt_count: Number(inv.attempt_count || 0),
          raw: inv, synced_at: new Date().toISOString(),
        }, { onConflict: 'id' })
        a.invoices++
      }

      // 3) CHARGES -> cash collected, fees, net
      const charges = await stripeList(acct.key, 'charges', {
        'created[gte]': String(createdGte),
        'expand[]': 'data.balance_transaction',
      })
      for (const ch of charges) {
        if (!ch.paid || ch.status !== 'succeeded') continue
        const bt = ch.balance_transaction as any
        const amount = cents(ch.amount)
        const fee = bt && typeof bt === 'object' ? cents(bt.fee) : Number((amount * 0.029 + 0.30).toFixed(2))
        const net = bt && typeof bt === 'object' ? cents(bt.net) : Number((amount - fee).toFixed(2))
        const email = (ch.billing_details as any)?.email || (ch.receipt_email as string) || null
        const name = (ch.billing_details as any)?.name || null
        const custId = typeof ch.customer === 'string' ? ch.customer : null
        const clientId = await resolveClient(custId, email, name)
        await supabase.from('payments').upsert({
          source: 'stripe', source_event_id: `stripe_${ch.id}`,
          amount, fee, net_amount: net, currency: String(ch.currency || 'usd').toUpperCase(),
          customer_email: email, customer_name: name,
          payment_date: new Date((ch.created as number) * 1000).toISOString(),
          payment_type: ch.invoice ? 'monthly' : 'one_time',
          description: (ch.description as string) || null,
          stripe_invoice_id: (ch.invoice as string) || null,
          account_label: acct.label,
          metadata: { charge_id: ch.id }, client_id: clientId, matched: !!clientId,
        }, { onConflict: 'source_event_id' })
        a.charges++
      }

      totals.subscriptions += a.subscriptions
      totals.invoices += a.invoices
      totals.charges += a.charges
      totals.mrr += a.mrr
      perAccount.push(a)
    }

    // Daily MRR snapshot (movement is derived day-over-day from these rows).
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
