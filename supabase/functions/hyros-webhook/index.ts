import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Verify webhook secret if configured
    const webhookSecret = Deno.env.get('HYROS_WEBHOOK_SECRET')
    if (webhookSecret) {
      const providedSecret = req.headers.get('x-webhook-secret') || new URL(req.url).searchParams.get('secret')
      if (providedSecret !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Invalid webhook secret' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    const payload = await req.json()

    // Hyros wraps event data: { type, body, eventId, timestamp, subscriptionId }
    const eventType = payload.type || 'unknown'
    const body = payload.body || payload
    const lead = body.lead || {}
    const product = body.product || {}
    const price = product.USDPrice || product.price || {}
    const lastSource = body.lastSource || {}
    const firstSource = body.firstSource || {}

    // Revenue: use USD price, fall back to regular price
    const revenue = parseFloat(price.price || 0) - parseFloat(price.refunded || 0) - parseFloat(price.discount || 0)

    // Attribution chain — extract campaign/ad info from sources
    const attribution = body.attribution || []
    const trafficSource = lastSource.trafficSource?.name || firstSource.trafficSource?.name || null

    // Extract campaign details from attribution if available
    let campaignId = null
    let campaignName = null
    let adSetName = null
    let adName = null
    for (const attr of attribution) {
      if (attr.campaignId || attr.campaign_id) campaignId = attr.campaignId || attr.campaign_id
      if (attr.campaignName || attr.campaign_name) campaignName = attr.campaignName || attr.campaign_name
      if (attr.adSetName || attr.adset_name) adSetName = attr.adSetName || attr.adset_name
      if (attr.adName || attr.ad_name) adName = attr.adName || attr.ad_name
    }

    // Fall back to source-level names
    if (!campaignName) campaignName = lastSource.name || firstSource.name || null

    // Date
    const eventDate = body.UTCDate || body.date || payload.timestamp || new Date().toISOString()
    const dateStr = eventDate.includes('T') ? eventDate.split('T')[0] : eventDate

    const record = {
      event_type: eventType,
      event_date: dateStr,
      email: lead.email || null,
      first_name: lead.firstName || null,
      last_name: lead.lastName || null,
      phone: lead.phoneNumbers?.[0] || null,
      revenue,
      currency: price.currency || 'USD',
      campaign_id: campaignId,
      campaign_name: campaignName,
      ad_set_name: adSetName,
      ad_name: adName,
      source: trafficSource,
      tag: Array.isArray(lead.tags) ? lead.tags.join(', ') : (lead.tags || null),
      product_name: product.name || null,
      product_category: product.category?.name || null,
      order_id: body.orderId || null,
      is_qualified: body.qualified ?? null,
      is_recurring: body.recurring ?? false,
      hyros_event_id: payload.eventId || null,
      raw_payload: payload,
    }

    const { error } = await supabase
      .from('hyros_events')
      .insert(record)

    if (error) {
      console.error('Insert error:', error)
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ status: 'ok' }),
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
