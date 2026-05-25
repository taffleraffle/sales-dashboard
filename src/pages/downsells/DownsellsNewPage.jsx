// /sales/downsells/new — pick a contract → write opening context →
// create thread → redirect into the session.
//
// Two-step UX in a single page:
//   Step 1: pick the contract (client) the downsell is for
//   Step 2: write the opening context (what's the situation?)
// Then submit → insert thread + invoke coach → navigate to /sales/downsells/<id>

import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Loader, AlertCircle, Search, ChevronRight, Plus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { ICON } from '../../utils/constants'

export default function DownsellsNewPage() {
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [contracts, setContracts] = useState([])
  const [loading, setLoading]     = useState(true)
  const [loadErr, setLoadErr]     = useState(null)
  const [query, setQuery]         = useState('')
  const [picked, setPicked]       = useState(null)
  const [opener, setOpener]       = useState('')
  const [creating, setCreating]   = useState(false)
  const [createErr, setCreateErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setLoadErr(null)
      const { data, error } = await supabase
        .from('contracts')
        .select('id, client_name, client_company, contract_type, fee_amount_usd, status, updated_at')
        .order('updated_at', { ascending: false })
      if (cancelled) return
      if (error) setLoadErr(error.message)
      else setContracts(data || [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filtered = contracts.filter(c => {
    if (!query.trim()) return true
    const q = query.toLowerCase()
    return (c.client_name || '').toLowerCase().includes(q)
        || (c.client_company || '').toLowerCase().includes(q)
  })

  async function submit(e) {
    e?.preventDefault()
    if (!picked || !opener.trim() || creating) return
    setCreating(true); setCreateErr(null)
    const { data: inserted, error: insertErr } = await supabase
      .from('contract_downsell_threads')
      .insert({
        contract_id: picked.id,
        closer_id: profile?.teamMemberId || null,
        opening_context: opener.trim(),
        status: 'open',
      })
      .select()
      .single()
    if (insertErr) {
      setCreating(false)
      setCreateErr(insertErr.message)
      return
    }
    // Fire the coach (don't await — let the session page handle the
    // response). If it 412s (policy not seeded), the session page shows
    // a Retry coach button.
    supabase.functions.invoke('contract-downsell-coach', {
      body: { thread_id: inserted.id },
    }).catch(() => {})

    navigate(`/sales/downsells/${inserted.id}`)
  }

  return (
    <div className="max-w-[900px] mx-auto">
      <Link to="/sales/downsells" className="editorial-btn-ghost" style={{ marginBottom: 16, display: 'inline-flex' }}>
        <ArrowLeft size={ICON.sm} /> All sessions
      </Link>

      <div className="mb-6 pb-4" style={{ borderBottom: '1px solid var(--rule)' }}>
        <span className="eyebrow eyebrow-accent">OPT Digital · New downsell</span>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--ink)', margin: '8px 0 0' }}>
          Start a coaching <em style={{ fontStyle: 'italic' }}>session</em>
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6, maxWidth: 640 }}>
          Pick the client this is for, then set the scene. The coach will pull the contract's current fee + terms for context and propose a margin-safe offer.
        </p>
      </div>

      {/* Step 1 — pick a contract */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="eyebrow eyebrow-bare">1. Pick the client</span>
          {picked && (
            <button type="button" onClick={() => setPicked(null)} className="editorial-btn-ghost" style={{ fontSize: 11 }}>
              Change
            </button>
          )}
        </div>

        {picked ? (
          <div className="tile tile-feedback p-4" style={{ borderLeft: '3px solid var(--accent)' }}>
            <p style={{ fontSize: 15, color: 'var(--ink)', margin: 0, fontWeight: 500 }}>{picked.client_name}</p>
            {picked.client_company && (
              <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '2px 0 0' }}>{picked.client_company}</p>
            )}
            <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', margin: '8px 0 0' }}>
              {picked.contract_type === 'retainer' ? 'Retainer' : 'Trial'}
              {picked.fee_amount_usd ? ` · $${Number(picked.fee_amount_usd).toLocaleString()}` : ''}
            </p>
          </div>
        ) : (
          <>
            <div className="relative mb-3">
              <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)' }} />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by client name or company…"
                className="editorial-input w-full"
                style={{ paddingLeft: 34 }}
                autoFocus
              />
            </div>

            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader className="animate-spin" size={20} style={{ color: 'var(--ink-3)' }} />
              </div>
            )}

            {loadErr && (
              <div className="tile tile-feedback p-3 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
                <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
                <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0 }}>{loadErr}</p>
              </div>
            )}

            {!loading && !loadErr && filtered.length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic', padding: '16px 0' }}>
                {contracts.length === 0
                  ? <>No contracts on file. <Link to="/sales/contracts/add" style={{ color: 'var(--ink)' }}>Add one first</Link>.</>
                  : 'No matches — try a different search.'}
              </p>
            )}

            {!loading && !loadErr && filtered.length > 0 && (
              <div className="tile tile-feedback p-0 overflow-hidden" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {filtered.map((c, idx) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setPicked(c)}
                    className="w-full text-left flex items-center justify-between gap-3 px-4 py-3"
                    style={{
                      borderBottom: idx < filtered.length - 1 ? '1px solid var(--rule)' : 'none',
                      cursor: 'pointer',
                      background: 'transparent',
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--paper-2)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    <div>
                      <p style={{ fontSize: 14, color: 'var(--ink)', margin: 0, fontWeight: 500 }}>{c.client_name}</p>
                      {c.client_company && (
                        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '2px 0 0' }}>{c.client_company}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                        {c.contract_type === 'retainer' ? 'Retainer' : 'Trial'}
                        {c.fee_amount_usd ? ` · $${Number(c.fee_amount_usd).toLocaleString()}` : ''}
                      </span>
                      <ChevronRight size={14} style={{ color: 'var(--ink-3)' }} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Step 2 — opening context (only enabled after a client is picked) */}
      {picked && (
        <form onSubmit={submit}>
          <div className="mb-4">
            <span className="eyebrow eyebrow-bare">2. Set the scene</span>
            <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '6px 0 10px' }}>
              What's the client asking for, and what triggered it? The more the coach knows up front, the fewer discovery turns it needs.
            </p>
            <textarea
              value={opener}
              onChange={e => setOpener(e.target.value)}
              placeholder={`e.g. Client said cash flow is tight this month and asked if we can pause the retainer for 30 days. They're 6 weeks into the 90-day. Website is launched, GBP rankings are climbing.`}
              rows={5}
              className="editorial-input w-full"
              style={{ resize: 'vertical' }}
              required
            />
          </div>

          {createErr && (
            <div className="tile tile-feedback p-3 mb-3 flex items-start gap-3" style={{ borderLeft: '3px solid var(--down)' }}>
              <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: 12, color: 'var(--ink)', margin: 0 }}>{createErr}</p>
            </div>
          )}

          <div className="flex items-center justify-end">
            <button type="submit" disabled={creating || !opener.trim()} className="editorial-btn-primary">
              {creating ? <><Loader size={ICON.sm} className="animate-spin" /> Opening…</> : <><Plus size={ICON.sm} /> Open session</>}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
