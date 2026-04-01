import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const payload = await req.json()
    const event = payload

    // Handle relevant Stripe events
    const eventType = event.type
    if (!['checkout.session.completed', 'invoice.payment_succeeded', 'charge.succeeded'].includes(eventType)) {
      return new Response(JSON.stringify({ status: 'ignored', type: eventType }), { status: 200 })
    }

    const obj = event.data?.object || {}

    // Extract payment details
    const amountCents = obj.amount_total || obj.amount_paid || obj.amount || 0
    const amount = amountCents / 100
    const fee = obj.application_fee_amount ? obj.application_fee_amount / 100 : amount * 0.076 // ~7.6% Stripe effective rate
    const netAmount = amount - fee
    const email = obj.customer_email || obj.receipt_email || obj.billing_details?.email || null
    const name = obj.customer_details?.name || obj.billing_details?.name || null
    const description = obj.description || obj.metadata?.description || null

    // Auto-match to client by email
    let clientId = null
    let matched = false
    if (email) {
      const { data: client } = await supabase
        .from('clients')
        .select('id')
        .ilike('email', email)
        .limit(1)
        .single()
      if (client) {
        clientId = client.id
        matched = true
      }
    }

    // Insert payment (idempotent via source_event_id)
    const { error } = await supabase.from('payments').upsert({
      source: 'stripe',
      source_event_id: event.id,
      amount,
      fee: Number(fee.toFixed(2)),
      net_amount: Number(netAmount.toFixed(2)),
      currency: (obj.currency || 'usd').toUpperCase(),
      customer_email: email,
      customer_name: name,
      payment_date: new Date((obj.created || Date.now() / 1000) * 1000).toISOString(),
      payment_type: description?.toLowerCase().includes('trial') ? 'trial'
        : description?.toLowerCase().includes('ascen') ? 'ascension'
        : 'monthly',
      description,
      metadata: { stripe_event_type: eventType, stripe_customer_id: obj.customer },
      client_id: clientId,
      matched,
    }, { onConflict: 'source_event_id' })

    if (error) {
      console.error('Payment insert error:', error)
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    return new Response(JSON.stringify({ status: 'ok', matched, amount }), { status: 200 })

  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
