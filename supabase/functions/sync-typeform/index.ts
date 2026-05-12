// sync-typeform — pulls every response from the two OPT funnels and
// upserts them into public.typeform_responses keyed on response_id.
//
//   POST /functions/v1/sync-typeform { days?: number, forms?: string[] }
//
// Defaults: 90-day window, both forms (h4il4Sla restoration + WndFLJux electrician).
// Idempotent — re-running the same window is a no-op.
//
// The hidden field on each response carries the Meta UTM context already
// (utm_campaign / utm_content = ad name / utm_term = ad set ID). After
// upsert we run a one-shot UPDATE that resolves utm_content → ads.ad_name
// to populate typeform_responses.ad_id for the attribution view to join on.
//
// Typeform API reference (verified 2026-05-12):
//   GET /forms/{form_id}/responses?page_size=1000&since=<ISO-8601>
//     -> { items: Response[], total_items, page_count }
//
// A response's `answers[]` is an ordered array of field replies. Field IDs
// differ between forms, so we extract by `type` rather than field ID:
//   - first  text          = first_name
//   - second text          = last_name
//   - email                = email
//   - phone_number         = phone
//   - choice with label matching $-pattern = revenue_tier
// The `hidden` map already gives us utm_*.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const TYPEFORM_KEY = Deno.env.get('TYPEFORM_API_KEY')
const TYPEFORM_BASE = 'https://api.typeform.com'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const DEFAULT_FORMS = [
  { id: 'h4il4Sla', name: 'Restoration Funnel' },
  { id: 'WndFLJux', name: 'Electrician Funnel' },
]

const QUALIFIED_TIERS = new Set([
  '$30-$50,000', '$50k-$75k/m', '$75k-$100k/m', '$100k - $250k/m', '$250,000/m+',
])
const UNQUALIFIED_TIERS = new Set([
  '$0-$30,000',
])

function classifyTier(revenueLabel: string | null, endingScreen: string | null): 'qualified' | 'unqualified' | 'abandoned' {
  if (!revenueLabel) return 'abandoned'
  if (QUALIFIED_TIERS.has(revenueLabel)) return 'qualified'
  if (UNQUALIFIED_TIERS.has(revenueLabel)) return 'unqualified'
  // Defensive fallback: anything containing a $-digit pattern that looks
  // like sub-30k gets unqualified, otherwise qualified.
  if (/\$0-\$30/.test(revenueLabel) || /under.*30/i.test(revenueLabel)) return 'unqualified'
  if (/\$\d/.test(revenueLabel)) return 'qualified'
  return 'abandoned'
}

// Pull the meaningful values out of the unstructured Typeform answers[].
function extractFields(answers: any[]): {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  revenue_tier: string | null
} {
  let first_name: string | null = null
  let last_name: string | null = null
  let email: string | null = null
  let phone: string | null = null
  let revenue_tier: string | null = null

  let textCount = 0
  // Capture every choice answer with a $-tier label. The form asks
  // marketing spend FIRST and revenue SECOND. The LAST $-tier choice in
  // the answers array is the revenue answer.
  const dollarChoices: string[] = []
  for (const a of answers || []) {
    const t = a?.type
    if (t === 'text') {
      const v = a.text
      if (textCount === 0) first_name = v || null
      else if (textCount === 1) last_name = v || null
      textCount++
    } else if (t === 'email') {
      email = a.email || null
    } else if (t === 'phone_number') {
      phone = a.phone_number || null
    } else if (t === 'choice') {
      const label = a.choice?.label || ''
      if (/\$\s*\d/.test(label)) dollarChoices.push(label)
    }
  }
  // Revenue tier = the LAST $-tier choice in the form (marketing spend comes first).
  if (dollarChoices.length) revenue_tier = dollarChoices[dollarChoices.length - 1]
  return { first_name, last_name, email, phone, revenue_tier }
}

async function fetchPagedResponses(formId: string, since: string | null) {
  const PAGE_SIZE = 1000
  const all: any[] = []
  let pageToken: string | null = null
  let pageNum = 0
  while (true) {
    pageNum++
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) })
    if (since) params.set('since', since)
    if (pageToken) params.set('before', pageToken)
    const url = `${TYPEFORM_BASE}/forms/${formId}/responses?${params}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TYPEFORM_KEY}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`Typeform /forms/${formId}/responses ${res.status}: ${txt.slice(0, 300)}`)
    }
    const json = await res.json()
    const items: any[] = json.items || []
    all.push(...items)
    // Typeform paginates by `before` (token = earliest response's token).
    // When we get a full page, the next page starts before the last token.
    if (items.length < PAGE_SIZE) break
    pageToken = items[items.length - 1]?.token || null
    if (!pageToken || pageNum >= 50) break
  }
  return all
}

function toRow(formId: string, formName: string, raw: any) {
  const hidden = raw.hidden || {}
  const { first_name, last_name, email, phone, revenue_tier } = extractFields(raw.answers || [])
  const tier = classifyTier(revenue_tier, raw.thankyou_screen_ref || null)
  return {
    response_id: raw.response_id || raw.token,
    form_id: formId,
    form_name: formName,
    landed_at: raw.landed_at || null,
    submitted_at: raw.submitted_at || null,
    first_name,
    last_name,
    email: email || hidden.email || null,
    phone: phone || hidden.phone_number || null,
    revenue_tier,
    tier,
    ending_screen: raw.thankyou_screen_ref || null,
    utm_source: hidden.utm_source || null,
    utm_medium: hidden.utm_medium || null,
    utm_campaign: hidden.utm_campaign || null,
    utm_term: hidden.utm_term || null,
    utm_content: hidden.utm_content || null,
    ad_id: null,    // resolved post-upsert
    raw_payload: raw,
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const reply = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!TYPEFORM_KEY) return reply({ error: 'TYPEFORM_API_KEY not set' }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* allow empty */ }
  const days = typeof body.days === 'number' ? body.days : 90
  const forms: { id: string; name: string }[] = Array.isArray(body.forms)
    ? body.forms.map((f: any) => typeof f === 'string' ? ({ id: f, name: f }) : f)
    : DEFAULT_FORMS

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const sinceTs = new Date(Date.now() - days * 86400 * 1000).toISOString()
  const summary: any = { since: sinceTs, forms: {}, ad_resolved: 0, errors: [] }

  for (const f of forms) {
    try {
      const items = await fetchPagedResponses(f.id, sinceTs)
      const rows = items.map(r => toRow(f.id, f.name, r))
      if (rows.length) {
        const { error } = await supabase
          .from('typeform_responses')
          .upsert(rows, { onConflict: 'response_id' })
        if (error) summary.errors.push(`${f.id} upsert: ${error.message}`)
      }
      summary.forms[f.id] = { name: f.name, fetched: items.length, upserted: rows.length }
    } catch (e) {
      summary.errors.push(`${f.id}: ${(e as Error).message}`)
      summary.forms[f.id] = { error: (e as Error).message }
    }
  }

  // Resolve ad_id by matching utm_content to ads.ad_name.
  // Run as a single SQL UPDATE so all rows get the link in one round trip.
  try {
    const { data: adRows } = await supabase
      .from('ads')
      .select('ad_id, ad_name')
      .not('ad_name', 'is', null)
    const byName: Record<string, string> = {}
    for (const a of adRows || []) {
      if (a.ad_name && !byName[a.ad_name]) byName[a.ad_name] = a.ad_id
    }
    // Pull responses that still need linking
    const { data: needAdLink } = await supabase
      .from('typeform_responses')
      .select('response_id, utm_content')
      .is('ad_id', null)
      .not('utm_content', 'is', null)
    const updates: { response_id: string; ad_id: string }[] = []
    for (const r of needAdLink || []) {
      const adId = byName[r.utm_content!]
      if (adId) updates.push({ response_id: r.response_id, ad_id: adId })
    }
    // Plain UPDATE per row — much simpler than upsert and avoids the
    // generated-column ("qualified") problem that bites .upsert(*).
    if (updates.length) {
      let resolved = 0
      for (const u of updates) {
        const { error } = await supabase
          .from('typeform_responses')
          .update({ ad_id: u.ad_id })
          .eq('response_id', u.response_id)
        if (error) {
          summary.errors.push(`ad_id resolve ${u.response_id}: ${error.message}`)
        } else {
          resolved++
        }
      }
      summary.ad_resolved = resolved
    }
  } catch (e) {
    summary.errors.push(`ad_id resolve: ${(e as Error).message}`)
  }

  return reply({ ok: true, ...summary })
})
