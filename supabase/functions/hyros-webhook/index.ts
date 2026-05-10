// hyros-webhook — receives HYROS attribution events and writes to hyros_events.
//
// HYROS payload shape (verified against /v1/api/v1.0/calls + /leads, 2026-05-11):
//   {
//     type: "call.attributed" | "sale.attributed" | ...,
//     eventId, timestamp, subscriptionId,
//     body: {
//       lead: { email, firstName, lastName, phoneNumbers[], tags[] },
//       product: { name, category, USDPrice: { price, refunded, discount, currency } },
//       firstSource: {                       // the source that originally created the lead
//         name,                              // = campaign nickname (e.g. "Adv +")
//         tag,                               // = utm-style ad-id tag (e.g. "@adv-120245091801410530")
//         adSource: {
//           adSourceId,                      // = Meta ad_id (NEW — was being missed)
//           adAccountId,                     // = Meta account_id
//           platform                         // FACEBOOK | TIKTOK | ...
//         },
//         sourceLinkAd: {                    // populated when the source link maps to a specific ad
//           adSourceId,                      // = Meta ad_id (CAN DIFFER from firstSource.adSource.adSourceId)
//           name                             // = Meta ad_name (e.g. "Video - scuba")
//         },
//         trafficSource: { id, name },
//         clickDate, clickId
//       },
//       lastSource: { ...same shape as firstSource },
//       orderId,
//       qualified, recurring,
//       UTCDate
//     }
//   }
//
// For call events, payload.body is the call object directly (id, lead, firstSource, ...).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://sales-dashboard-ftct.onrender.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Extract the Meta ad_id from a HYROS source object. Prefer sourceLinkAd
// (the actual ad the lead clicked) over adSource (the ad that originally
// generated the source link — usually same but can drift for shared links).
function pickAdId(source: any): { adId: string | null; adName: string | null } {
  if (!source) return { adId: null, adName: null }
  const linkAdId = source.sourceLinkAd?.adSourceId || null
  const linkAdName = source.sourceLinkAd?.name || null
  const adSourceId = source.adSource?.adSourceId || null
  return {
    adId: linkAdId || adSourceId,
    adName: linkAdName,
  }
}

// Parse a HYROS date string into YYYY-MM-DD.
// Handles both ISO 8601 ("2026-05-10T13:13:43+12:00") and the date-only
// (used by event_date column) and the legacy "Sun May 10 01:13:43 UTC 2026" format.
function parseEventDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString().split('T')[0]
  if (raw.includes('T')) return raw.split('T')[0]
  const parsed = new Date(raw)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0]
  return new Date().toISOString().split('T')[0]
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const payload = await req.json()
    const eventType = payload.type || 'unknown'
    const body = payload.body || payload
    const lead = body.lead || {}
    const product = body.product || {}
    const price = product.USDPrice || product.price || {}

    // ── Sources ──────────────────────────────────────────────────────────
    const lastSource = body.lastSource || {}
    const firstSource = body.firstSource || {}

    const { adId: lastAdId, adName: lastAdName } = pickAdId(lastSource)
    const { adId: firstAdId, adName: firstAdName } = pickAdId(firstSource)

    // The "primary" Meta ad for this event: prefer last-click attribution
    // (lastSource), fall back to first-click (firstSource).
    const meta_ad_id = lastAdId || firstAdId
    const source_link_ad_id = lastSource.sourceLinkAd?.adSourceId || firstSource.sourceLinkAd?.adSourceId || null
    const source_link_ad_name = lastAdName || firstAdName

    // ── Campaign + ad metadata ──────────────────────────────────────────
    const campaign_id = lastSource.adSource?.adAccountId || firstSource.adSource?.adAccountId || null
    const campaign_name = lastSource.name || firstSource.name || null
    const ad_name = source_link_ad_name
    const ad_set_name = lastSource.category?.name || firstSource.category?.name || null
    const trafficSource = lastSource.trafficSource?.name || firstSource.trafficSource?.name || null

    // ── Revenue ─────────────────────────────────────────────────────────
    const revenue = parseFloat(price.price || 0) - parseFloat(price.refunded || 0) - parseFloat(price.discount || 0)

    // ── Date ────────────────────────────────────────────────────────────
    const event_date = parseEventDate(body.UTCDate || body.date || body.creationDate || payload.timestamp)

    // ── Lead tags (array, e.g. ["!calendly","$call-...","@adv-12024509..."]) ──
    const lead_tags: string[] = Array.isArray(lead.tags) ? lead.tags : []

    // ── Call-specific state (QUALIFIED | UNQUALIFIED | DISQUALIFIED | ...) ──
    const call_state = body.state || null

    // ── Click id for downstream attribution debugging ───────────────────
    const click_id = lastSource.clickId || firstSource.clickId || null

    const record = {
      event_type: eventType,
      event_date,
      email: lead.email || null,
      first_name: lead.firstName || null,
      last_name: lead.lastName || null,
      phone: lead.phoneNumbers?.[0] || null,
      revenue,
      currency: price.currency || 'USD',
      campaign_id,
      campaign_name,
      ad_set_name,
      ad_name,
      source: trafficSource,
      tag: lead_tags.join(', ') || null,
      lead_tags,
      product_name: product.name || null,
      product_category: product.category?.name || null,
      order_id: body.orderId || null,
      is_qualified: body.qualified ?? null,
      is_recurring: body.recurring ?? false,
      hyros_event_id: payload.eventId || null,
      meta_ad_id,
      source_link_ad_id,
      source_link_ad_name,
      click_id,
      call_state,
      raw_payload: payload,
    }

    const { error } = await supabase.from('hyros_events').insert(record)

    if (error) {
      console.error('Insert error:', error)
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ status: 'ok', meta_ad_id, source_link_ad_id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
