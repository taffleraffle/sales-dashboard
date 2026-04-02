import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchPaymentToClient, autoCreateCommission } from '../_shared/matchPayment.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY not configured')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ghlApiKey = Deno.env.get('GHL_API_KEY') || ''
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Parse optional params
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '50')
    const days = parseInt(url.searchParams.get('days') || '30')
    const createdAfter = Math.floor(Date.now() / 1000) - (days * 86400)

    // Fetch recent charges from Stripe
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/charges?limit=${limit}&created[gte]=${createdAfter}`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    )
    if (!stripeRes.ok) {
      const err = await stripeRes.text()
      throw new Error(`Stripe API error: ${err}`)
    }

    const stripeData = await stripeRes.json()
    const charges = stripeData.data || []

    let synced = 0
    let skipped = 0
    let matched = 0

    for (const charge of charges) {
      if (charge.status !== 'succeeded') { skipped++; continue }

      const sourceEventId = `stripe_charge_${charge.id}`

      // Check if already imported
      const { data: existing } = await supabase
        .from('payments')
        .select('id')
        .eq('source_event_id', sourceEventId)
        .limit(1)
        .single()

      if (existing) { skipped++; continue }

      const amount = (charge.amount || 0) / 100
      const fee = charge.application_fee_amount ? charge.application_fee_amount / 100 : Number((amount * 0.076).toFixed(2))
      const netAmount = Number((amount - fee).toFixed(2))
      const email = charge.receipt_email || charge.billing_details?.email || null
      const name = charge.billing_details?.name || charge.description || null
      const phone = charge.billing_details?.phone || null
      const paymentDate = new Date(charge.created * 1000).toISOString()

      // Match to client
      const matchResult = await matchPaymentToClient(
        supabase, email, phone, name, ghlApiKey, ghlLocationId
      )

      const desc = (charge.description || '').toLowerCase()
      const paymentType = desc.includes('trial') ? 'trial'
        : desc.includes('ascen') ? 'ascension'
        : desc.includes('pif') ? 'pif'
        : 'monthly'

      const { data: payment, error } = await supabase.from('payments').insert({
        source: 'stripe',
        source_event_id: sourceEventId,
        amount,
        fee,
        net_amount: netAmount,
        currency: (charge.currency || 'usd').toUpperCase(),
        customer_email: email,
        customer_name: name,
        payment_date: paymentDate,
        payment_type: paymentType,
        description: charge.description || null,
        metadata: { stripe_charge_id: charge.id, stripe_customer: charge.customer },
        client_id: matchResult.clientId,
        matched: matchResult.matched,
      }).select('id').single()

      if (!error && payment) {
        synced++
        if (matchResult.matched) {
          matched++
          await autoCreateCommission(supabase, payment.id, matchResult.clientId!, netAmount, paymentDate)
        }
      }
    }

    return new Response(
      JSON.stringify({ status: 'ok', total: charges.length, synced, skipped, matched }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
