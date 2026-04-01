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

    // Extract payment details from Fanbasis payload
    // Adapt field names to match Fanbasis's actual webhook format
    const amount = parseFloat(payload.amount || payload.total || 0)
    const feeRate = 0.035 // Fanbasis 3.5% fee
    const fee = Number((amount * feeRate).toFixed(2))
    const netAmount = Number((amount - fee).toFixed(2))
    const email = payload.email || payload.customer_email || payload.buyer_email || null
    const name = payload.name || payload.customer_name || payload.buyer_name || null
    const eventId = payload.id || payload.transaction_id || payload.payment_id || `fanbasis_${Date.now()}`

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

    // Determine payment type
    const desc = (payload.description || payload.product_name || '').toLowerCase()
    const paymentType = desc.includes('trial') ? 'trial'
      : desc.includes('pif') || desc.includes('pay in full') ? 'pif'
      : desc.includes('ascen') ? 'ascension'
      : 'monthly'

    const { error } = await supabase.from('payments').upsert({
      source: 'fanbasis',
      source_event_id: eventId,
      amount,
      fee,
      net_amount: netAmount,
      currency: (payload.currency || 'USD').toUpperCase(),
      customer_email: email,
      customer_name: name,
      payment_date: payload.created_at || payload.payment_date || new Date().toISOString(),
      payment_type: paymentType,
      description: payload.description || payload.product_name || null,
      metadata: payload,
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
