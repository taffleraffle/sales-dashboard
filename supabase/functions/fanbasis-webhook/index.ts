import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchPaymentToClient, autoCreateCommission } from '../_shared/matchPayment.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': 'https://sales-dashboard-ftct.onrender.com', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ghlApiKey = Deno.env.get('GHL_API_KEY') || ''
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const payload = await req.json()

    // Fanbasis wraps the real payload in `data` for current webhook events
    // (payment.succeeded, subscription.renewed, product.purchased). Older
    // events posted fields at the root, so we fall back to the root.
    // Without this, every field below resolves to undefined and we'd write
    // a row with amount=0 / email=null / matched=false.
    const core = (payload && typeof payload.data === 'object' && payload.data) ? payload.data : payload
    const buyer = core.buyer || {}
    const item = core.item || {}
    const sub = core.subscription || {}

    const amount = parseFloat(core.total_price || core.unit_price || core.amount || 0)
    const fee = parseFloat(core.application_fee_amount || 0) || Number((amount * 0.035).toFixed(2))
    const netAmount = Number((amount - fee).toFixed(2))
    const email = buyer.email || core.email || core.customer_email || null
    const name = buyer.name || core.name || core.customer_name || null
    const phone = buyer.phone || core.phone || null
    // Dedupe across the multiple events Fanbasis fires per payment (e.g.
    // payment.succeeded + subscription.renewed both carry the same payment_id):
    // use payment_id as source_event_id so the upsert collapses them to one row.
    const eventId = core.payment_id || payload.payment_id || payload.id || `fanbasis_${Date.now()}`
    const paymentDate = core.created_at || core.payment_date || payload.created_at || new Date().toISOString()
    const eventType = payload.type || payload.event_type || core.event_type || null
    const currency = String(core.currency || payload.currency || 'USD').toUpperCase()
    const description = core.description || payload.description || item.title || payload.product_name || null

    // Match to client
    const { clientId, matched } = await matchPaymentToClient(
      supabase, email, phone, name, ghlApiKey, ghlLocationId
    )

    const itemTitle = String(item.title || core.description || description || '').toLowerCase()
    const isSubscription = item.type === 'subscription' || !!sub.id || core.payment_type === 'subscription'
    const paymentType = itemTitle.includes('trial') ? 'trial'
      : itemTitle.includes('pif') || itemTitle.includes('pay in full') ? 'pif'
      : isSubscription ? 'monthly'
      : 'one_time'

    const { data: payment, error } = await supabase.from('payments').upsert({
      source: 'fanbasis',
      source_event_id: eventId,
      amount, fee, net_amount: netAmount,
      currency,
      customer_email: email, customer_name: name,
      payment_date: paymentDate,
      payment_type: paymentType,
      description,
      metadata: { ...payload, _event_type: eventType },
      client_id: clientId, matched,
    }, { onConflict: 'source_event_id' }).select('id').single()

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    // Auto-create commission entries
    if (matched && clientId && payment) {
      await autoCreateCommission(supabase, payment.id, clientId, netAmount, paymentDate)
    }

    return new Response(JSON.stringify({ status: 'ok', matched, amount, clientId }), { status: 200 })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 })
  }
})
