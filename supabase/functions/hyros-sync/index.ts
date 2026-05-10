// hyros-sync — daily backfill of HYROS calls + leads via REST API.
//
// The hyros-webhook captures real-time events but (a) HYROS retroactively
// reassigns attribution as click data settles and (b) older events may have
// been missed when the webhook was misconfigured. This sync pulls /calls and
// /leads from the HYROS API for a recent window and upserts into hyros_events.
//
//   POST /functions/v1/hyros-sync { days?: number }
//
// Defaults to 30-day window. Idempotent — uses hyros_event_id (call id /
// lead id) as the dedup key.
//
// API reference (verified 2026-05-11 against the actual responses):
//   GET /v1/api/v1.0/calls?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&pageSize=100
//     -> { result: Call[], request_id }
//   GET /v1/api/v1.0/leads?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&pageSize=100
//     -> { result: Lead[], request_id }
//
// Sales endpoint (/sales) currently returns empty for OPT — sales aren't
// being pushed into HYROS. Will start working when the Stripe → HYROS pipe
// is wired up separately. This sync handles it transparently (no errors).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const HYROS_KEY = Deno.env.get('HYROS_API_KEY')
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function pickAdId(source: any): { adId: string | null; adName: string | null } {
  if (!source) return { adId: null, adName: null }
  return {
    adId: source.sourceLinkAd?.adSourceId || source.adSource?.adSourceId || null,
    adName: source.sourceLinkAd?.name || null,
  }
}

// HYROS dates come in two formats:
//   - ISO 8601: "2026-05-10T13:13:43+12:00"  (from /leads, /sales)
//   - JS legacy: "Sun May 10 01:13:43 UTC 2026"  (from /calls — Deno's Date
//     constructor doesn't reliably parse this so we manual-extract).
const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

// Parse any HYROS date format into a YYYY-MM-DD string for the
// hyros_events.event_date DATE column. HYROS mixes formats:
//   - ISO 8601: "2026-05-10T13:13:43+12:00"  (/leads, /sales, webhook)
//   - JS legacy: "Sun May 10 01:13:43 UTC 2026"  (/calls API)
// Always returns a parseable yyyy-mm-dd (falls back to today on garbage).
function parseHyrosDate(raw: unknown): string {
  const today = () => new Date().toISOString().split('T')[0]
  if (typeof raw !== 'string' || !raw) return today()
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  // ISO 8601 (with T)
  if (raw.includes('T')) {
    const head = raw.split('T')[0]
    if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head
  }
  // "DDD MMM DD HH:mm:ss [UTC|GMT] YYYY" — JS legacy toString output
  const m = raw.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+\d{2}:\d{2}:\d{2}\s+(?:UTC|GMT)?\s*(\d{4})$/)
  if (m) {
    const mm = MONTHS[m[1] as keyof typeof MONTHS]
    if (mm) return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`
  }
  // Fallback: JS Date constructor
  try {
    const d = new Date(raw)
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]
  } catch { /* */ }
  return today()
}

function mapToRecord(event_type: string, raw: any) {
  const lead = raw.lead || {}
  const lastSource = raw.lastSource || {}
  const firstSource = raw.firstSource || {}
  const { adId: lastAdId, adName: lastAdName } = pickAdId(lastSource)
  const { adId: firstAdId, adName: firstAdName } = pickAdId(firstSource)
  const meta_ad_id = lastAdId || firstAdId
  const source_link_ad_id = lastSource.sourceLinkAd?.adSourceId || firstSource.sourceLinkAd?.adSourceId || null
  const source_link_ad_name = lastAdName || firstAdName
  const lead_tags: string[] = Array.isArray(lead.tags) ? lead.tags : []
  return {
    event_type,
    event_date: parseHyrosDate(raw.UTCDate || raw.date || raw.creationDate || lead.UTCJoinDate || lead.joinDate),
    email: lead.email || null,
    first_name: lead.firstName || null,
    last_name: lead.lastName || null,
    phone: lead.phoneNumbers?.[0] || null,
    revenue: 0,
    currency: 'USD',
    campaign_id: lastSource.adSource?.adAccountId || firstSource.adSource?.adAccountId || null,
    campaign_name: lastSource.name || firstSource.name || null,
    ad_set_name: lastSource.category?.name || firstSource.category?.name || null,
    ad_name: source_link_ad_name,
    source: lastSource.trafficSource?.name || firstSource.trafficSource?.name || null,
    tag: lead_tags.join(', ') || null,
    lead_tags,
    is_qualified: raw.qualified ?? null,
    is_recurring: raw.recurring ?? false,
    hyros_event_id: raw.id || null,
    meta_ad_id,
    source_link_ad_id,
    source_link_ad_name,
    click_id: lastSource.clickId || firstSource.clickId || null,
    call_state: raw.state || null,
    raw_payload: raw,
  }
}

async function fetchHyrosPaged(endpoint: 'calls' | 'leads' | 'sales', fromDate: string, toDate: string) {
  const PAGE = 100
  const out: any[] = []
  let pageId: string | null = null
  let pageNum = 0
  while (true) {
    pageNum++
    const params = new URLSearchParams({ fromDate, toDate, pageSize: String(PAGE) })
    if (pageId) params.set('pageId', pageId)
    const url = `${HYROS_BASE}/${endpoint}?${params}`
    const res = await fetch(url, { headers: { 'API-Key': HYROS_KEY!, Accept: 'application/json' } })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HYROS /${endpoint} ${res.status}: ${errText.slice(0, 300)}`)
    }
    const json = await res.json()
    const rows = json.result || []
    out.push(...rows)
    // HYROS uses cursor pagination via `pageId` on the next response
    pageId = json.pageId || json.nextPageId || null
    if (!pageId || rows.length < PAGE || pageNum >= 50) break
  }
  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!HYROS_KEY) return json({ error: 'HYROS_API_KEY not set in Supabase secrets' }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* allow empty body for GET-like usage */ }
  const days = typeof body.days === 'number' ? body.days : 30

  const fromDate = (() => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().split('T')[0] })()
  const toDate = new Date().toISOString().split('T')[0]
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  const summary: Record<string, any> = { fromDate, toDate, days, calls: 0, leads: 0, sales: 0, errors: [] as string[] }

  // ── Calls ─────────────────────────────────────────────────────────────
  try {
    const calls = await fetchHyrosPaged('calls', fromDate, toDate)
    const records = calls.map(c => mapToRecord('call.attributed', c)).filter(r => r.hyros_event_id)
    if (records.length) {
      const { error } = await supabase.from('hyros_events').upsert(records, { onConflict: 'hyros_event_id' })
      if (error) summary.errors.push(`calls upsert: ${error.message}`)
    }
    summary.calls = records.length
  } catch (e) { summary.errors.push(`calls fetch: ${(e as Error).message}`) }

  // ── Leads ─────────────────────────────────────────────────────────────
  try {
    const leads = await fetchHyrosPaged('leads', fromDate, toDate)
    const records = leads.map(l => mapToRecord('lead.attributed', l)).filter(r => r.hyros_event_id)
    if (records.length) {
      const { error } = await supabase.from('hyros_events').upsert(records, { onConflict: 'hyros_event_id' })
      if (error) summary.errors.push(`leads upsert: ${error.message}`)
    }
    summary.leads = records.length
  } catch (e) { summary.errors.push(`leads fetch: ${(e as Error).message}`) }

  // ── Sales (currently empty for OPT — handles gracefully) ──────────────
  try {
    const sales = await fetchHyrosPaged('sales', fromDate, toDate)
    const records = sales.map(s => {
      const r = mapToRecord('sale.attributed', s)
      const p = s.product?.USDPrice || s.product?.price || {}
      r.revenue = parseFloat(p.price || 0) - parseFloat(p.refunded || 0) - parseFloat(p.discount || 0)
      r.currency = p.currency || 'USD'
      return r
    }).filter(r => r.hyros_event_id)
    if (records.length) {
      const { error } = await supabase.from('hyros_events').upsert(records, { onConflict: 'hyros_event_id' })
      if (error) summary.errors.push(`sales upsert: ${error.message}`)
    }
    summary.sales = records.length
  } catch (e) { summary.errors.push(`sales fetch: ${(e as Error).message}`) }

  return json({ ok: true, ...summary })
})
