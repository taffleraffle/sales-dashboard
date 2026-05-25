// /sales/downsells/new — minimum-viable session opener.
//
//   Step 1: who is the client?  (free-text — they don't need a contract row)
//   Step 2: what's the situation? (opening context)
//
// Submit → insert thread → invoke coach → redirect to session.
// No contract picker. The session is decoupled from the contracts table
// per Ben's "should just be a chat" framing.

import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

export default function DownsellsNewPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [clientName, setClientName]     = useState('')
  const [clientCompany, setClientCompany] = useState('')
  const [opener, setOpener]             = useState('')
  const [creating, setCreating]         = useState(false)
  const [err, setErr]                   = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!clientName.trim() || !opener.trim() || creating) return
    setCreating(true); setErr(null)
    const { data: inserted, error: insertErr } = await supabase
      .from('contract_downsell_threads')
      .insert({
        contract_id: null,
        closer_id: profile?.teamMemberId || null,
        client_name: clientName.trim(),
        client_company: clientCompany.trim() || null,
        opening_context: opener.trim(),
        status: 'open',
      })
      .select()
      .single()
    if (insertErr) {
      setCreating(false)
      setErr(insertErr.message)
      return
    }
    // Fire the coach and wait — if it returns an error, surface it
    // here so the closer doesn't land on a broken session page.
    const { data: coachRes, error: invErr } = await supabase.functions.invoke('contract-downsell-coach', {
      body: { thread_id: inserted.id },
    })
    if (invErr || coachRes?.error) {
      setCreating(false)
      setErr(invErr?.message || coachRes?.error || 'Coach call failed')
      // The thread row still exists; let them visit it to see what's there
      // (the chat page also surfaces errors + retry).
      return
    }
    navigate(`/sales/downsells/${inserted.id}`)
  }

  return (
    <div className="max-w-[720px] mx-auto">
      <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All sessions
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · New downsell</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Open a <em style={{ fontStyle: 'italic' }}>chat</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6 }}>
          Tell the coach who the client is and what's going on. It'll ask follow-up questions, then give you options.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div>
          <label style={lblStyle}>Client name</label>
          <input
            type="text"
            value={clientName}
            onChange={e => setClientName(e.target.value)}
            placeholder="e.g. Eric, Sarah Kim, John Smith"
            className="editorial-input w-full mt-1"
            autoFocus
            required
          />
        </div>

        <div>
          <label style={lblStyle}>Company <span style={{ textTransform: 'none', color: 'var(--ink-3)', fontStyle: 'italic', letterSpacing: 0, fontWeight: 400, marginLeft: 6 }}>— optional</span></label>
          <input
            type="text"
            value={clientCompany}
            onChange={e => setClientCompany(e.target.value)}
            placeholder="e.g. Apex Roofing, Smith Remodeling"
            className="editorial-input w-full mt-1"
          />
        </div>

        <div>
          <label style={lblStyle}>What's the situation?</label>
          <textarea
            value={opener}
            onChange={e => setOpener(e.target.value)}
            placeholder={`Tell the coach what the client is asking for, what's driving it, and anything we've delivered so far.\n\ne.g. "Client said cash flow is tight this month, wants to know if we can pause for 30 days. They're 6 weeks into the 90-day retainer, site is launched, GBP rankings climbing."`}
            rows={6}
            className="editorial-input w-full mt-1"
            style={{ resize: 'vertical' }}
            required
          />
        </div>

        {err && (
          <div className="tile tile-feedback p-3 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
            <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
            <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0, fontFamily: 'var(--mono)' }}>{err}</p>
          </div>
        )}

        <div className="flex items-center justify-end">
          <button type="submit" disabled={creating || !clientName.trim() || !opener.trim()} className="editorial-btn-primary">
            {creating ? <><Loader size={ICON.sm} className="animate-spin" /> Opening…</> : <><Plus size={ICON.sm} /> Start chat</>}
          </button>
        </div>
      </form>
    </div>
  )
}

const lblStyle = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
}
