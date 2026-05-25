// /sales/downsells/:id — single coaching session.
// Just a chat. Header shows who, body is bubbles + input.

import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { ICON } from '../../utils/constants'
import { CoachThread } from './CoachThread'

export default function DownsellsSessionPage() {
  const { id } = useParams()
  const [thread, setThread]     = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      const { data: t, error: tErr } = await supabase
        .from('contract_downsell_threads')
        .select('*, contracts(client_name, client_company)')
        .eq('id', id)
        .maybeSingle()
      if (cancelled) return
      if (tErr) { setError(tErr.message); setLoading(false); return }
      if (!t) { setError('Session not found'); setLoading(false); return }
      setThread(t)

      const { data: msgs, error: mErr } = await supabase
        .from('contract_downsell_messages')
        .select('*')
        .eq('thread_id', id)
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (mErr) { setError(`Failed to load messages: ${mErr.message}`); setLoading(false); return }
      setMessages(msgs || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [id])

  async function refresh() {
    const [{ data: t }, { data: msgs }] = await Promise.all([
      supabase.from('contract_downsell_threads').select('*, contracts(client_name, client_company)').eq('id', id).maybeSingle(),
      supabase.from('contract_downsell_messages').select('*').eq('thread_id', id).order('created_at', { ascending: true }),
    ])
    if (t) setThread(t)
    if (msgs) setMessages(msgs)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader className="animate-spin" size={24} style={{ color: 'var(--ink-3)' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-[720px] mx-auto">
        <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
          <ArrowLeft size={ICON.sm} /> All sessions
        </Link>
        <div className="tile tile-feedback p-4 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
          <AlertCircle size={ICON.md} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{error}</p>
        </div>
      </div>
    )
  }

  const clientName    = thread.client_name    || thread.contracts?.client_name    || 'Unknown'
  const clientCompany = thread.client_company || thread.contracts?.client_company || null

  return (
    <div className="max-w-[720px] mx-auto">
      <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All sessions
      </Link>

      {/* Slim header — just who we're talking about */}
      <div className="mb-5 pb-3" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">Downsell chat</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)', margin: '4px 0 0' }}>{clientName}</h1>
        {clientCompany && (
          <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '2px 0 0' }}>{clientCompany}</p>
        )}
      </div>

      <CoachThread thread={thread} messages={messages} onChange={refresh} />
    </div>
  )
}
