// sync-ghl-contacts — pulls every GHL contact and persists their Meta-lead
// attribution (adId, adSetId, campaignId, utmCampaign, utmContent, formName,
// etc.) to public.ghl_contacts. The dashboard's close resolver uses this as
// a 2nd attribution tier so closes that came through Meta Lead Forms get
// credited to the exact creative even when typeform / HYROS missed them.
//
//   POST /functions/v1/sync-ghl-contacts { days?: number }
//
// `days` defaults to 365 (effectively all-time for OPT's account). Pagination
// uses GHL's POST /contacts/search endpoint with `startAfter` cursor.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const GHL_KEY  = Deno.env.get('GHL_API_KEY')
const GHL_LOC  = Deno.env.get('GHL_LOCATION_ID')
const GHL_BASE = 'https://services.leadconnectorhq.com'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function pickAttr(c: any) {
  // GHL puts the most recent attribution on `lastAttributionSource` and the
  // first-touch on `attributionSource`. Both are objects, not arrays.
  const last  = (c.lastAttributionSource && typeof c.lastAttributionSource === 'object') ? c.lastAttributionSource : {}
  const first = (c.attributionSource     && typeof c.attributionSource     === 'object') ? c.attributionSource     : {}
  return { last, first }
}

function mapContact(c: any) {
  const { last, first } = pickAttr(c)
  const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || null
  return {
    ghl_contact_id:    c.id,
    first_name:        c.firstName || null,
    last_name:         c.lastName  || null,
    full_name:         fullName,
    email:             c.email || null,
    phone:             c.phone || null,
    source:            c.source || null,
    company_name:      c.companyName || null,
    date_added:        c.dateAdded   || null,
    date_updated:      c.dateUpdated || null,
    tags:              Array.isArray(c.tags) ? c.tags : null,
    // last-touch
    last_ad_id:           last.adId            || null,
    last_adset_id:        last.adSetId         || null,
    last_campaign_id:     last.campaignId      || null,
    last_utm_source:      last.utmSource       || null,
    last_utm_medium:      last.utmMedium       || null,
    last_utm_campaign:    last.utmCampaign     || null,
    last_utm_content:     last.utmContent      || null,
    last_form_id:         last.formId          || null,
    last_form_name:       last.formName        || null,
    last_session_source:  last.sessionSource   || null,
    // first-touch
    first_ad_id:          first.adId           || null,
    first_campaign_id:    first.campaignId     || null,
    first_utm_campaign:   first.utmCampaign    || null,
    first_utm_content:    first.utmContent     || null,
    first_form_name:      first.formName       || null,
    raw_payload:          c,
  }
}

async function fetchPage(page: number, pageLimit: number) {
  // POST /contacts/search supports `page` (1-indexed) for pagination plus
  // `pageLimit` per page. We sort dateAdded DESC so the most recent contacts
  // surface first — useful for incremental runs.
  const body = {
    locationId: GHL_LOC,
    page,
    pageLimit,
    sort: [{ field: 'dateAdded', direction: 'desc' }],
  }
  const res = await fetch(`${GHL_BASE}/contacts/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`GHL /contacts/search page=${page} ${res.status}: ${txt.slice(0, 300)}`)
  }
  return await res.json()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const reply = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!GHL_KEY || !GHL_LOC) return reply({ error: 'GHL_API_KEY / GHL_LOCATION_ID not set' }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* */ }
  const days = typeof body.days === 'number' ? body.days : 365
  const cutoffMs = Date.now() - days * 86400 * 1000

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  const PAGE = 100
  const summary: any = { fetched: 0, upserted: 0, withAttribution: 0, pages: 0, errors: [] as string[] }

  for (let page = 1; page < 200; page++) {
    let json: any
    try {
      json = await fetchPage(page, PAGE)
    } catch (e) {
      summary.errors.push((e as Error).message)
      break
    }
    const contacts: any[] = json.contacts || []
    summary.pages++
    if (!contacts.length) break

    const oldestMs = new Date(contacts[contacts.length - 1].dateAdded || 0).getTime()
    const rows = contacts.map(mapContact)
    const withAttr = rows.filter(r => r.last_ad_id || r.last_utm_campaign).length
    summary.fetched += contacts.length
    summary.withAttribution += withAttr

    const { error } = await supabase
      .from('ghl_contacts')
      .upsert(rows, { onConflict: 'ghl_contact_id' })
    if (error) {
      summary.errors.push(`page ${page} upsert: ${error.message}`)
    } else {
      summary.upserted += rows.length
    }

    if (oldestMs < cutoffMs) break
    if (contacts.length < PAGE) break
  }

  return reply({ ok: true, ...summary })
})
