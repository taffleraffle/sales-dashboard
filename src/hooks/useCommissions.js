import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useCommissionSettings() {
  const [settings, setSettings] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('commission_settings')
      .select('*, member:team_members(id, name, role)')
      .order('member_id')
    setSettings(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const upsert = async (memberId, updates) => {
    const { error } = await supabase
      .from('commission_settings')
      .upsert({ member_id: memberId, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'member_id' })
    if (!error) await fetch()
    return !error
  }

  // Build a map: member_id → settings
  const settingsMap = {}
  for (const s of settings) settingsMap[s.member_id] = s

  return { settings, settingsMap, loading, upsert, refresh: fetch }
}

export function useClients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async (silent) => {
    if (!silent) setLoading(true)
    const { data } = await supabase
      .from('clients')
      .select('*, closer:team_members!clients_closer_id_fkey(name), setter:team_members!clients_setter_id_fkey(name)')
      .order('name')
    setClients((data || []).map(c => ({
      ...c,
      closer_name: c.closer?.name || '—',
      setter_name: c.setter?.name || '—',
    })))
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const clientsMap = {}
  for (const c of clients) clientsMap[c.id] = c

  // Silent refresh doesn't flash loading state
  const silentRefresh = useCallback(() => fetch(true), [fetch])

  return { clients, clientsMap, setClients, loading, refresh: fetch, silentRefresh }
}

export function usePayments(period) {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    let query = supabase
      .from('payments')
      .select('*, client:clients(name, company_name, closer_id, setter_id)')
      .order('payment_date', { ascending: false })

    if (period) {
      const start = `${period}-01`
      const end = `${period}-31`
      query = query.gte('payment_date', start).lte('payment_date', `${end}T23:59:59`)
    }

    query.then(({ data }) => {
      setPayments(data || [])
      setLoading(false)
    })
  }, [period])

  const matchPayment = async (paymentId, clientId, userEmail) => {
    // Get the payment to find its Stripe customer ID
    const { data: payment } = await supabase
      .from('payments').select('metadata').eq('id', paymentId).single()

    // Match this payment + set audit fields
    const { error } = await supabase
      .from('payments')
      .update({
        client_id: clientId,
        matched: true,
        manually_matched: true,
        matched_by: userEmail || null,
        matched_at: new Date().toISOString(),
      })
      .eq('id', paymentId)
    if (error) return false

    // Auto-match all other payments from the same Stripe customer
    const stripeCustomerId = payment?.metadata?.stripe_customer_id
    if (stripeCustomerId) {
      const { data: unmatched } = await supabase
        .from('payments').select('id, metadata').eq('matched', false)
      if (unmatched) {
        const sameCustomer = unmatched.filter(p => p.metadata?.stripe_customer_id === stripeCustomerId)
        for (const p of sameCustomer) {
          await supabase.from('payments').update({ client_id: clientId, matched: true }).eq('id', p.id)
        }
      }
    }

    // Also match by same customer_email
    const { data: thisPayment } = await supabase.from('payments').select('customer_email').eq('id', paymentId).single()
    if (thisPayment?.customer_email) {
      await supabase.from('payments')
        .update({ client_id: clientId, matched: true })
        .eq('customer_email', thisPayment.customer_email)
        .eq('matched', false)
    }

    return true
  }

  const unmatchPayment = async (paymentId, userEmail) => {
    // Unmatch the payment
    const { error } = await supabase
      .from('payments')
      .update({
        client_id: null,
        matched: false,
        manually_matched: true,
        matched_by: userEmail || null,
        matched_at: new Date().toISOString(),
      })
      .eq('id', paymentId)
    if (error) return false

    // Delete commission_ledger entries for this payment
    await supabase.from('commission_ledger').delete().eq('payment_id', paymentId)
    return true
  }

  const refresh = () => {
    setLoading(true)
    let query = supabase.from('payments')
      .select('*, client:clients(name, company_name, closer_id, setter_id)')
      .order('payment_date', { ascending: false })
    if (period) {
      query = query.gte('payment_date', `${period}-01`).lte('payment_date', `${period}-31T23:59:59`)
    }
    query.then(({ data }) => { setPayments(data || []); setLoading(false) })
  }

  return { payments, loading, matchPayment, unmatchPayment, refresh }
}

export function useCommissionLedger(memberId, period) {
  const [ledger, setLedger] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('commission_ledger')
      .select('*, client:clients(name, company_name), member:team_members(name, role), payment:payments(amount, net_amount, source, payment_date, customer_name, payment_number)')
      .order('created_at', { ascending: false })

    if (memberId) query = query.eq('member_id', memberId)
    if (period) query = query.eq('period', period)

    const { data } = await query
    setLedger(data || [])
    setLoading(false)
  }, [memberId, period])

  useEffect(() => { fetch() }, [fetch])

  const updateStatus = async (entryId, status) => {
    const { error } = await supabase
      .from('commission_ledger')
      .update({ status })
      .eq('id', entryId)
    if (!error) await fetch()
    return !error
  }

  return { ledger, loading, updateStatus, refresh: fetch }
}

export function usePaymentBlacklist() {
  const [blacklist, setBlacklist] = useState([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('payment_blacklist')
      .select('*')
      .order('created_at')
    setBlacklist(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  const addPattern = async (pattern, matchField, createdBy) => {
    const { error } = await supabase
      .from('payment_blacklist')
      .insert({ pattern, match_field: matchField, created_by: createdBy })
    if (!error) await fetch()
    return !error
  }

  const removePattern = async (id) => {
    const { error } = await supabase
      .from('payment_blacklist')
      .delete()
      .eq('id', id)
    if (!error) await fetch()
    return !error
  }

  const isBlacklisted = (payment) => {
    return blacklist.some(b => {
      if (b.match_field === 'email') return (payment.customer_email || '').toLowerCase().includes(b.pattern.toLowerCase())
      if (b.match_field === 'name') return (payment.customer_name || '').toLowerCase().includes(b.pattern.toLowerCase())
      if (b.match_field === 'description') return (payment.description || '').toLowerCase().includes(b.pattern.toLowerCase())
      return false
    })
  }

  return { blacklist, loading, addPattern, removePattern, isBlacklisted, refresh: fetch }
}
