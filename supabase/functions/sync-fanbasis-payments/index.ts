import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { matchPaymentToClient, autoCreateCommission } from '../_shared/matchPayment.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://sales-dashboard-ftct.onrender.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const fanbasisKey = Deno.env.get('FANBASIS_API_KEY')
    if (!fanbasisKey) {
      return new Response(
        JSON.stringify({ status: 'skipped', message: 'FANBASIS_API_KEY not configured. Add it to Supabase function secrets to enable pull sync.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const ghlApiKey = Deno.env.get('GHL_API_KEY') || ''
    const ghlLocationId = Deno.env.get('GHL_LOCATION_ID') || ''
    const supabase = createClient(supabaseUrl, supabaseKey)

    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const days = parseInt(url.searchParams.get('days') || '90')

    // Fanbasis API — fetch recent transactions
    // Docs: https://docs.fanbasis.com/api or check your Fanbasis dashboard
    // Common endpoints: /api/v1/transactions, /api/v1/payments
    const since = new Date(Date.now() - days * 86400000).toISOString()

    // Try common Fanbasis API endpoints
    let transactions: Array<Record<string, unknown>> = []
    const baseUrls = [
      'https://api.fanbasis.com/api/v1/transactions',
      'https://api.fanbasis.com/api/v1/payments',
      'https://app.fanbasis.com/api/v1/transactions',
    ]

    for (const baseUrl of baseUrls) {
      try {
        const res = await fetch(`${baseUrl}?since=${since}&limit=${limit}`, {
          headers: {
            'Authorization': `Bearer ${fanbasisKey}`,
            'Accept': 'application/json',
          },
        })
        if (res.ok) {
          const data = await res.json()
          transactions = data.data || data.transactions || data.payments || data || []
          if (Array.isArray(transactions) && transactions.length > 0) break
        }
      } catch {
        continue
      }
    }

    if (transactions.length === 0) {
      return new Response(
        JSON.stringify({ status: 'ok', message: 'No transactions found from Fanbasis API', synced: 0, matched: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let synced = 0, matched = 0, skipped = 0

    for (const txn of transactions) {
      const buyer = (txn.buyer || txn.customer || {}) as Record<string, string>
      const item = (txn.item || txn.product || {}) as Record<string, string>

      const amount = parseFloat(String(txn.total_price || txn.amount || txn.unit_price || 0))
      if (amount <= 0) { skipped++; continue }

      const fee = parseFloat(String(txn.application_fee_amount || 0)) || Number((amount * 0.035).toFixed(2))
      const netAmount = Number((amount - fee).toFixed(2))
      const email = buyer.email || (txn as Record<string, string>).email || null
      const name = buyer.name || (txn as Record<string, string>).customer_name || null
      const phone = buyer.phone || (txn as Record<string, string>).phone || null
      const eventId = String(txn.payment_id || txn.id || txn.transaction_id || `fanbasis_pull_${Date.now()}_${synced}`)
      const sourceEventId = eventId.startsWith('fanbasis_') ? eventId : `fanbasis_${eventId}`
      const paymentDate = String(txn.created_at || txn.payment_date || txn.date || new Date().toISOString())

      // Check duplicate
      const { data: existing } = await supabase
        .from('payments').select('id').eq('source_event_id', sourceEventId).limit(1).single()
      if (existing) { skipped++; continue }

      // Match to client
      const matchResult = await matchPaymentToClient(
        supabase, email, phone, name, ghlApiKey, ghlLocationId
      )

      const itemTitle = String(item.title || (txn as Record<string, string>).description || '').toLowerCase()
      const isSubscription = item.type === 'subscription' || !!(txn as Record<string, string>).subscription_id
      const paymentType = itemTitle.includes('trial') ? 'trial'
        : itemTitle.includes('pif') || itemTitle.includes('pay in full') ? 'pif'
        : isSubscription ? 'monthly'
        : 'one_time'

      const { data: payment, error } = await supabase.from('payments').upsert({
        source: 'fanbasis',
        source_event_id: sourceEventId,
        amount, fee, net_amount: netAmount,
        currency: String((txn as Record<string, string>).currency || 'USD').toUpperCase(),
        customer_email: email, customer_name: name,
        payment_date: paymentDate,
        payment_type: paymentType,
        description: (txn as Record<string, string>).description || item.title || null,
        metadata: txn,
        client_id: matchResult.clientId,
        matched: matchResult.matched,
      }, { onConflict: 'source_event_id' }).select('id').single()

      if (!error && payment) {
        synced++
        if (matchResult.matched && matchResult.clientId) {
          matched++
          await autoCreateCommission(supabase, payment.id, matchResult.clientId, netAmount, paymentDate)
        }
      }
    }

    return new Response(
      JSON.stringify({ status: 'ok', total: transactions.length, synced, skipped, matched }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
