import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null
  return phone.replace(/\D/g, '').slice(-10)
}

/**
 * Match a payment to a client using cascade: email → phone → name → GHL lookup.
 * Returns { clientId, matched, autoCreated }
 */
export async function matchPaymentToClient(
  supabase: SupabaseClient,
  email: string | null,
  phone: string | null,
  name: string | null,
  ghlApiKey?: string,
  ghlLocationId?: string,
): Promise<{ clientId: string | null; matched: boolean; autoCreated: boolean }> {

  // 1. Match by email (case-insensitive)
  if (email) {
    const { data } = await supabase
      .from('clients').select('id').ilike('email', email).limit(1).single()
    if (data) return { clientId: data.id, matched: true, autoCreated: false }
  }

  // 2. Match by phone (last 10 digits)
  if (phone) {
    const norm = normalizePhone(phone)
    if (norm) {
      const { data: allClients } = await supabase.from('clients').select('id, phone')
      const match = (allClients || []).find(c => c.phone && normalizePhone(c.phone) === norm)
      if (match) return { clientId: match.id, matched: true, autoCreated: false }
    }
  }

  // 3. Match by name (fuzzy — contains)
  if (name && name.length > 2) {
    const { data } = await supabase
      .from('clients').select('id').ilike('name', `%${name}%`).limit(1).single()
    if (data) return { clientId: data.id, matched: true, autoCreated: false }
  }

  // 4. GHL API lookup (if credentials available)
  if (ghlApiKey && ghlLocationId && (email || phone)) {
    try {
      const query = email || phone
      const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' }
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${ghlLocationId}&query=${encodeURIComponent(query)}&limit=1`,
        { headers: ghlHeaders }
      )
      if (res.ok) {
        const data = await res.json()
        const contact = data.contacts?.[0]
        if (contact) {
          // Auto-create client from GHL contact
          const { data: newClient, error } = await supabase.from('clients').insert({
            name: contact.name || contact.firstName + ' ' + contact.lastName || name || 'Unknown',
            email: contact.email || email,
            phone: contact.phone || phone,
            company_name: contact.companyName || null,
            ghl_contact_id: contact.id,
            stage: 'trial',
            trial_start_date: new Date().toISOString().split('T')[0],
          }).select('id').single()

          if (!error && newClient) {
            return { clientId: newClient.id, matched: true, autoCreated: true }
          }
        }
      }
    } catch { /* GHL lookup failed — continue */ }
  }

  return { clientId: null, matched: false, autoCreated: false }
}

/**
 * Auto-create commission ledger entries for a matched payment within the commission window.
 */
export async function autoCreateCommission(
  supabase: SupabaseClient,
  paymentId: string,
  clientId: string,
  netAmount: number,
  paymentDate: string,
) {
  // Fetch client with closer/setter
  const { data: client } = await supabase
    .from('clients').select('id, closer_id, setter_id, trial_start_date, stage').eq('id', clientId).single()
  if (!client) return

  // Check commission window (months 0-3)
  if (client.trial_start_date) {
    const start = new Date(client.trial_start_date)
    const payment = new Date(paymentDate)
    const monthsSince = (payment.getTime() - start.getTime()) / (30.44 * 86400000)
    if (monthsSince > 4) return // Outside window
  }

  const period = paymentDate.slice(0, 7) // '2026-04'
  const commType = client.stage === 'trial' ? 'trial_close' : 'ascension'

  // Create commission for closer
  if (client.closer_id) {
    const { data: settings } = await supabase
      .from('commission_settings').select('commission_rate, ascension_rate').eq('member_id', client.closer_id).single()
    if (settings) {
      const rate = commType === 'trial_close' ? settings.commission_rate : (settings.ascension_rate || settings.commission_rate)
      if (rate > 0) {
        await supabase.from('commission_ledger').insert({
          member_id: client.closer_id,
          payment_id: paymentId,
          client_id: clientId,
          period,
          commission_type: commType,
          payment_amount: netAmount,
          commission_rate: rate,
          commission_amount: Number((netAmount * rate / 100).toFixed(2)),
          status: 'pending',
        })
      }
    }
  }

  // Create commission for setter
  if (client.setter_id) {
    const { data: settings } = await supabase
      .from('commission_settings').select('commission_rate').eq('member_id', client.setter_id).single()
    if (settings && settings.commission_rate > 0) {
      await supabase.from('commission_ledger').insert({
        member_id: client.setter_id,
        payment_id: paymentId,
        client_id: clientId,
        period,
        commission_type: commType,
        payment_amount: netAmount,
        commission_rate: settings.commission_rate,
        commission_amount: Number((netAmount * settings.commission_rate / 100).toFixed(2)),
        status: 'pending',
      })
    }
  }
}
