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

    // Parse Fanbasis payload structure: buyer, item, subscription nested objects
    const buyer = payload.buyer || {}
    const item = payload.item || {}
    const sub = payload.subscription || {}

    const amount = parseFloat(payload.total_price || payload.unit_price || payload.amount || 0)
    const fee = parseFloat(payload.application_fee_amount || 0) || Number((amount * 0.035).toFixed(2))
    const netAmount = Number((amount - fee).toFixed(2))
    const email = buyer.email || payload.email || payload.customer_email || null
    const name = buyer.name || payload.name || payload.customer_name || null
    const phone = buyer.phone || payload.phone || null
    const eventId = payload.payment_id || payload.id || `fanbasis_${Date.now()}`
    const paymentDate = payload.created_at || payload.payment_date || new Date().toISOString()

    // Match to client
    const { clientId, matched } = await matchPaymentToClient(
      supabase, email, phone, name, ghlApiKey, ghlLocationId
    )

    const itemTitle = (item.title || payload.description || '').toLowerCase()
    const isSubscription = item.type === 'subscription' || !!sub.id
    const paymentType = itemTitle.includes('trial') ? 'trial'
      : itemTitle.includes('pif') || itemTitle.includes('pay in full') ? 'pif'
      : isSubscription ? 'monthly'
      : 'one_time'

    const { data: payment, error } = await supabase.from('payments').upsert({
      source: 'fanbasis',
      source_event_id: eventId,
      amount, fee, net_amount: netAmount,
      currency: (payload.currency || 'USD').toUpperCase(),
      customer_email: email, customer_name: name,
      payment_date: paymentDate,
      payment_type: paymentType,
      description: payload.description || payload.product_name || null,
      metadata: payload,
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
