import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Approximate USD conversion rates
const USD_RATES: Record<string, number> = { USD: 1, NZD: 0.58, AUD: 0.63, GBP: 1.27, EUR: 1.08, CAD: 0.73 }

export function toUSD(amount: number, currency: string): number {
  const rate = USD_RATES[(currency || 'USD').toUpperCase()] || 1
  return Number((amount * rate).toFixed(2))
}

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null
  return phone.replace(/\D/g, '').slice(-10)
}

function normalizeForMatch(s: string): string {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '')
}

/**
 * Match a payment to a client using multiple strategies.
 */
export async function matchPaymentToClient(
  supabase: SupabaseClient,
  email: string | null,
  phone: string | null,
  name: string | null,
  ghlApiKey?: string,
  ghlLocationId?: string,
): Promise<{ clientId: string | null; matched: boolean; autoCreated: boolean; confidence: number; matchTier: string }> {

  // Fetch all clients once for multi-strategy matching
  const { data: allClients } = await supabase
    .from('clients')
    .select('id, name, email, phone, company_name')

  const clients = allClients || []

  // 1. Exact email match (case-insensitive) — confidence: 1.0
  if (email) {
    const emailLower = email.toLowerCase()
    const match = clients.find(c => c.email && c.email.toLowerCase() === emailLower)
    if (match) return { clientId: match.id, matched: true, autoCreated: false, confidence: 1.0, matchTier: 'exact_email' }
  }

  // 2. Email domain match — confidence: 0.7
  if (email) {
    const emailUser = email.split('@')[0]?.toLowerCase() || ''
    const emailDomain = email.split('@')[1]?.split('.')[0]?.toLowerCase() || ''
    for (const c of clients) {
      const cName = normalizeForMatch(c.name)
      const cCompany = normalizeForMatch(c.company_name)
      const normUser = normalizeForMatch(emailUser)
      const normDomain = normalizeForMatch(emailDomain)
      if (cName && normUser.length > 2 && (normUser.includes(cName) || cName.includes(normUser))) {
        return { clientId: c.id, matched: true, autoCreated: false, confidence: 0.7, matchTier: 'email_domain' }
      }
      if (cCompany && normDomain.length > 3 && (normDomain.includes(cCompany) || cCompany.includes(normDomain))) {
        return { clientId: c.id, matched: true, autoCreated: false, confidence: 0.7, matchTier: 'email_domain' }
      }
    }
  }

  // 3. Phone match (last 10 digits) — confidence: 0.9
  if (phone) {
    const norm = normalizePhone(phone)
    if (norm) {
      const match = clients.find(c => c.phone && normalizePhone(c.phone) === norm)
      if (match) return { clientId: match.id, matched: true, autoCreated: false, confidence: 0.9, matchTier: 'phone' }
    }
  }

  // 4. Name / company name match — confidence: 0.5
  if (name && name.length > 2) {
    const normName = normalizeForMatch(name)
    if (!['invoice', 'subscription', 'payment', 'update'].some(g => normName.includes(g))) {
      for (const c of clients) {
        const cName = normalizeForMatch(c.name)
        const cCompany = normalizeForMatch(c.company_name)
        if (cName && normName.length > 3 && (normName.includes(cName) || cName.includes(normName))) {
          return { clientId: c.id, matched: true, autoCreated: false, confidence: 0.5, matchTier: 'name' }
        }
        if (cCompany && normName.length > 4 && (normName.includes(cCompany) || cCompany.includes(normName))) {
          return { clientId: c.id, matched: true, autoCreated: false, confidence: 0.5, matchTier: 'name' }
        }
      }
    }
  }

  // 5. GHL API lookup — confidence: 0.6
  if (ghlApiKey && ghlLocationId && (email || phone)) {
    try {
      const query = email || phone
      const res = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${ghlLocationId}&query=${encodeURIComponent(query!)}&limit=1`,
        { headers: { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' } }
      )
      if (res.ok) {
        const data = await res.json()
        const contact = data.contacts?.[0]
        if (contact) {
          const { data: newClient, error } = await supabase.from('clients').insert({
            name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || name || 'Unknown',
            email: contact.email || email,
            phone: contact.phone || phone,
            company_name: contact.companyName || null,
            ghl_contact_id: contact.id,
            stage: 'trial',
            trial_start_date: new Date().toISOString().split('T')[0],
          }).select('id').single()
          if (!error && newClient) return { clientId: newClient.id, matched: true, autoCreated: true, confidence: 0.6, matchTier: 'ghl' }
        }
      }
    } catch { /* continue */ }
  }

  return { clientId: null, matched: false, autoCreated: false, confidence: 0, matchTier: 'none' }
}

/**
 * Auto-create commission ledger entries for a matched payment within the commission window.
 */
export async function autoCreateCommission(
  supabase: SupabaseClient,
  paymentId: string,
  clientId: string,
  netAmountUSD: number,
  paymentDate: string,
) {
  const { data: client } = await supabase
    .from('clients').select('id, closer_id, setter_id, trial_start_date, stage').eq('id', clientId).single()
  if (!client) return

  if (client.trial_start_date) {
    const start = new Date(client.trial_start_date)
    const payment = new Date(paymentDate)
    const monthsSince = (payment.getTime() - start.getTime()) / (30.44 * 86400000)
    if (monthsSince > 4) return
  }

  // Check if commission already exists for this payment
  const { data: existing } = await supabase
    .from('commission_ledger').select('id').eq('payment_id', paymentId).limit(1).single()
  if (existing) return // Already processed

  const period = paymentDate.slice(0, 7)
  const commType = client.stage === 'trial' ? 'trial_close' : 'ascension'

  if (client.closer_id) {
    const { data: settings } = await supabase
      .from('commission_settings').select('commission_rate, ascension_rate').eq('member_id', client.closer_id).single()
    if (settings) {
      const rate = commType === 'trial_close' ? settings.commission_rate : (settings.ascension_rate || settings.commission_rate)
      if (rate > 0) {
        await supabase.from('commission_ledger').insert({
          member_id: client.closer_id, payment_id: paymentId, client_id: clientId, period,
          commission_type: commType, payment_amount: netAmountUSD, commission_rate: rate,
          commission_amount: Number((netAmountUSD * rate / 100).toFixed(2)), status: 'pending',
        })
      }
    }
  }

  if (client.setter_id) {
    const { data: settings } = await supabase
      .from('commission_settings').select('commission_rate').eq('member_id', client.setter_id).single()
    if (settings && settings.commission_rate > 0) {
      await supabase.from('commission_ledger').insert({
        member_id: client.setter_id, payment_id: paymentId, client_id: clientId, period,
        commission_type: commType, payment_amount: netAmountUSD, commission_rate: settings.commission_rate,
        commission_amount: Number((netAmountUSD * settings.commission_rate / 100).toFixed(2)), status: 'pending',
      })
    }
  }
}
