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
    const stripeWebhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const body = await req.text()

    // Verify Stripe webhook signature if secret is configured
    if (stripeWebhookSecret) {
      const sig = req.headers.get('stripe-signature') || ''
      const parts = Object.fromEntries(sig.split(',').map(p => { const [k, v] = p.split('='); return [k, v] }))
      const timestamp = parts['t']
      const expectedSig = parts['v1']
      if (!timestamp || !expectedSig) {
        return new Response(JSON.stringify({ error: 'Missing stripe-signature' }), { status: 401 })
      }
      // Verify timestamp is within 5 minutes to prevent replay attacks
      const age = Math.abs(Date.now() / 1000 - parseInt(timestamp))
      if (age > 300) {
        return new Response(JSON.stringify({ error: 'Webhook timestamp too old' }), { status: 401 })
      }
      // HMAC-SHA256 verification
      const payload = `${timestamp}.${body}`
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(stripeWebhookSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
      const computed = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')
      if (computed !== expectedSig) {
        return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 401 })
      }
    }

    const event = JSON.parse(body)

    if (!event || typeof event !== 'object' || !event.type || !event.data?.object) {
      return new Response(JSON.stringify({ error: 'Invalid webhook payload' }), { status: 400 })
    }

    const eventType = event.type
    if (!['checkout.session.completed', 'invoice.payment_succeeded', 'charge.succeeded'].includes(eventType)) {
      return new Response(JSON.stringify({ status: 'ignored', type: eventType }), { status: 200 })
    }

    const obj = event.data.object
    const amountCents = obj.amount_total || obj.amount_paid || obj.amount || 0
    if (typeof amountCents !== 'number' || amountCents < 0) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), { status: 400 })
    }
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
