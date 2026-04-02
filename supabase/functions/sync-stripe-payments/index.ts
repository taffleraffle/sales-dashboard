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

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const days = parseInt(url.searchParams.get('days') || '90')
    const resync = url.searchParams.get('resync') === 'true'
    const createdAfter = Math.floor(Date.now() / 1000) - (days * 86400)

    // Fetch charges with expanded customer object for real name/email
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/charges?limit=${limit}&created[gte]=${createdAfter}&expand[]=data.customer`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } }
    )
    if (!stripeRes.ok) throw new Error(`Stripe API: ${await stripeRes.text()}`)

    const stripeData = await stripeRes.json()
    const charges = stripeData.data || []

    let synced = 0, skipped = 0, matched = 0, updated = 0

    for (const charge of charges) {
      if (charge.status !== 'succeeded') { skipped++; continue }

      const sourceEventId = `stripe_charge_${charge.id}`
      const stripeCustomerId = typeof charge.customer === 'object' ? charge.customer?.id : charge.customer

      // Get real customer name and email from expanded customer object
      const customerObj = typeof charge.customer === 'object' ? charge.customer : null
      const customerName = customerObj?.name || charge.billing_details?.name || null
      const customerEmail = customerObj?.email || charge.receipt_email || charge.billing_details?.email || null
      const customerPhone = customerObj?.phone || charge.billing_details?.phone || null

      // Extract invoice number from description
      const invoiceMatch = (charge.description || '').match(/Invoice\s*#?(\d+)/i)
      const invoiceNumber = invoiceMatch ? invoiceMatch[1] : null

      const amount = (charge.amount || 0) / 100
      const fee = charge.application_fee_amount ? charge.application_fee_amount / 100 : Number((amount * 0.029 + 0.30).toFixed(2))
      const netAmount = Number((amount - fee).toFixed(2))
      const paymentDate = new Date(charge.created * 1000).toISOString()

      // Check if already exists
      const { data: existing } = await supabase
        .from('payments').select('id').eq('source_event_id', sourceEventId).limit(1).single()

      if (existing && !resync) {
        // Update customer name/email if we now have better data
        if (customerName || customerEmail) {
          const updates: Record<string, unknown> = {}
          if (customerName) updates.customer_name = customerName
          if (customerEmail) updates.customer_email = customerEmail
          await supabase.from('payments').update(updates).eq('id', existing.id)
          updated++
        }
        skipped++
        continue
      }

      // Match to client
      const matchResult = await matchPaymentToClient(
        supabase, customerEmail, customerPhone, customerName, ghlApiKey, ghlLocationId
      )

      const desc = (charge.description || '').toLowerCase()
      const paymentType = desc.includes('trial') ? 'trial'
        : desc.includes('ascen') ? 'ascension'
        : desc.includes('pif') ? 'pif'
        : 'monthly'

      const { data: payment, error } = await supabase.from('payments').upsert({
        source: 'stripe',
        source_event_id: sourceEventId,
        amount, fee, net_amount: netAmount,
        currency: (charge.currency || 'usd').toUpperCase(),
        customer_email: customerEmail,
        customer_name: customerName,
        payment_date: paymentDate,
        payment_type: paymentType,
        description: charge.description || null,
        metadata: {
          stripe_charge_id: charge.id,
          stripe_customer_id: stripeCustomerId,
          invoice_number: invoiceNumber,
          customer_phone: customerPhone,
        },
        client_id: matchResult.clientId,
        matched: matchResult.matched,
      }, { onConflict: 'source_event_id' }).select('id').single()

      if (!error && payment) {
        synced++
        if (matchResult.matched && matchResult.clientId) {
          matched++
          await autoCreateCommission(supabase, payment.id, matchResult.clientId, netAmount, paymentDate)

          // Auto-match ALL other payments from same Stripe customer to this client
          if (stripeCustomerId) {
            await supabase.from('payments')
              .update({ client_id: matchResult.clientId, matched: true })
              .contains('metadata', { stripe_customer_id: stripeCustomerId })
              .is('client_id', null)
          }
        }
      }
    }

    return new Response(
      JSON.stringify({ status: 'ok', total: charges.length, synced, skipped, matched, updated }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
