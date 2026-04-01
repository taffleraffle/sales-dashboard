import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchPaymentToClient, autoCreateCommission } from '../_shared/matchPayment.ts'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ghlApiKey = Deno.env.get('GHL_API_KEY') || ''
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const event = await req.json()

    const eventType = event.type
    if (!['checkout.session.completed', 'invoice.payment_succeeded', 'charge.succeeded'].includes(eventType)) {
      return new Response(JSON.stringify({ status: 'ignored', type: eventType }), { status: 200 })
    }

    const obj = event.data?.object || {}
    const amountCents = obj.amount_total || obj.amount_paid || obj.amount || 0
    const amount = amountCents / 100
    const fee = obj.application_fee_amount ? obj.application_fee_amount / 100 : Number((amount * 0.076).toFixed(2))
    const netAmount = Number((amount - fee).toFixed(2))
    const email = obj.customer_email || obj.receipt_email || obj.billing_details?.email || null
    const name = obj.customer_details?.name || obj.billing_details?.name || null
    const phone = obj.customer_details?.phone || obj.billing_details?.phone || null
    const description = obj.description || obj.metadata?.description || null
    const paymentDate = new Date((obj.created || Date.now() / 1000) * 1000).toISOString()

    // Match to client (email → phone → name → GHL)
    const { clientId, matched } = await matchPaymentToClient(
      supabase, email, phone, name, ghlApiKey, ghlLocationId
    )

    // Determine payment type
    const desc = (description || '').toLowerCase()
    const paymentType = desc.includes('trial') ? 'trial'
      : desc.includes('ascen') ? 'ascension'
      : desc.includes('pif') ? 'pif'
      : 'monthly'

    // Insert payment
    const { data: payment, error } = await supabase.from('payments').upsert({
      source: 'stripe',
      source_event_id: event.id,
      amount, fee, net_amount: netAmount,
      currency: (obj.currency || 'usd').toUpperCase(),
      customer_email: email, customer_name: name,
      payment_date: paymentDate,
      payment_type: paymentType,
      description,
      metadata: { stripe_event_type: eventType, stripe_customer_id: obj.customer },
      client_id: clientId, matched,
    }, { onConflict: 'source_event_id' }).select('id').single()

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 })
    }

    // Auto-create commission entries if matched and within window
    if (matched && clientId && payment) {
      await autoCreateCommission(supabase, payment.id, clientId, netAmount, paymentDate)
    }

    return new Response(JSON.stringify({ status: 'ok', matched, amount, clientId }), { status: 200 })

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 })
  }
})
