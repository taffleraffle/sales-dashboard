import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Optional: filter to specific period
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const period = body.period // e.g. "2026-04"

    // 1. Fetch all matched payments
    const { data: allPayments } = await supabase
      .from('payments')
      .select('id, net_amount, payment_date, payment_type, client_id')
      .eq('matched', true)

    if (!allPayments?.length) {
      return new Response(JSON.stringify({ created: 0, message: 'No matched payments' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2. Fetch client details
    const clientIds = [...new Set(allPayments.map(p => p.client_id).filter(Boolean))]
    const { data: clientData } = await supabase
      .from('clients')
      .select('id, closer_id, setter_id, trial_start_date, stage')
      .in('id', clientIds)
    const clientMap: Record<string, any> = {}
    clientData?.forEach(c => { clientMap[c.id] = c })

    // 3. Fetch commission settings
    const { data: settingsData } = await supabase
      .from('commission_settings')
      .select('member_id, commission_rate, ascension_rate')
    const settingsMap: Record<string, any> = {}
    settingsData?.forEach(s => { settingsMap[s.member_id] = s })

    // 4. Check existing ledger entries
    const { data: existingEntries } = await supabase
      .from('commission_ledger')
      .select('payment_id, member_id')
    const existingSet = new Set(
      (existingEntries || []).map(e => `${e.payment_id}_${e.member_id}`)
    )

    // 5. Generate commission entries
    let created = 0
    const inserts: any[] = []

    for (const p of allPayments) {
      const client = clientMap[p.client_id]
      if (!client || (!client.closer_id && !client.setter_id)) continue

      // Commission window check (0-4 months from trial start)
      if (client.trial_start_date) {
        const monthsSince = (new Date(p.payment_date).getTime() - new Date(client.trial_start_date).getTime()) / (30.44 * 86400000)
        if (monthsSince > 4) continue
      }

      // Filter by period if specified
      const periodStr = p.payment_date.slice(0, 7)
      if (period && periodStr !== period) continue

      const commType = p.payment_type === 'trial' ? 'trial_close' : 'ascension'
      const netAmount = Number(p.net_amount) || 0
      if (netAmount <= 0) continue

      // Closer commission
      if (client.closer_id && settingsMap[client.closer_id]?.commission_rate > 0) {
        const key = `${p.id}_${client.closer_id}`
        if (!existingSet.has(key)) {
          const rate = settingsMap[client.closer_id].commission_rate
          inserts.push({
            member_id: client.closer_id,
            payment_id: p.id,
            client_id: client.id,
            period: periodStr,
            commission_type: commType,
            payment_amount: netAmount,
            commission_rate: rate,
            commission_amount: Number((netAmount * rate / 100).toFixed(2)),
            status: 'pending',
          })
        }
      }

      // Setter commission
      if (client.setter_id && settingsMap[client.setter_id]?.commission_rate > 0) {
        const key = `${p.id}_${client.setter_id}`
        if (!existingSet.has(key)) {
          const rate = settingsMap[client.setter_id].commission_rate
          inserts.push({
            member_id: client.setter_id,
            payment_id: p.id,
            client_id: client.id,
            period: periodStr,
            commission_type: commType,
            payment_amount: netAmount,
            commission_rate: rate,
            commission_amount: Number((netAmount * rate / 100).toFixed(2)),
            status: 'pending',
          })
        }
      }
    }

    // Batch insert
    if (inserts.length > 0) {
      const { error } = await supabase
        .from('commission_ledger')
        .upsert(inserts, { onConflict: 'payment_id,member_id' })
      if (error) throw error
      created = inserts.length
    }

    return new Response(
      JSON.stringify({ created, total_payments: allPayments.length, message: `Created ${created} commission entries` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
