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

    const payload = await req.json()

    const amount = parseFloat(payload.amount || payload.total || 0)
    const fee = Number((amount * 0.035).toFixed(2))
    const netAmount = Number((amount - fee).toFixed(2))
    const email = payload.email || payload.customer_email || payload.buyer_email || null
    const name = payload.name || payload.customer_name || payload.buyer_name || null
    const phone = payload.phone || payload.customer_phone || null
    const eventId = payload.id || payload.transaction_id || payload.payment_id || `fanbasis_${Date.now()}`
    const paymentDate = payload.created_at || payload.payment_date || new Date().toISOString()

    // Match to client
    const { clientId, matched } = await matchPaymentToClient(
      supabase, email, phone, name, ghlApiKey, ghlLocationId
    )

    const desc = (payload.description || payload.product_name || '').toLowerCase()
    const paymentType = desc.includes('trial') ? 'trial'
      : desc.includes('pif') || desc.includes('pay in full') ? 'pif'
      : desc.includes('ascen') ? 'ascension'
      : 'monthly'

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
