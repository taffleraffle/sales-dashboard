import { useEffect, useMemo, useState } from 'react'
import { Plus, Loader, Check, X, Edit3, Trash2, ChevronRight, ChevronDown } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { pagedFetch } from '../../lib/pagedFetch'

/*
  Messaging → Testing panel.

  Workflow Ben asked for (2026-05-16):
    1. Confirm an angle: give it a name + short label + optional hypothesis.
    2. Assign ad_ids to that angle (m2m so an ad can belong to multiple).
    3. See aggregate performance across assigned ads (spend, leads,
       booked, lives, closes, revenue from lib_typeform_ad_attribution +
       ad_daily_stats — same sources the Performance page uses).
    4. Mark verdict: testing → winner | loser | paused | archived.

  Tables: ad_angles + ad_angle_assignments (migration 053).
*/

const STATUS_OPTIONS = [
  { id: 'testing',  label: 'Testing',  color: '#b88714' },
  { id: 'winner',   label: 'Winner',   color: '#1f7a3a' },
  { id: 'loser',    label: 'Loser',    color: '#b41e1e' },
  { id: 'paused',   label: 'Paused',   color: 'var(--ink-4)' },
  { id: 'archived', label: 'Archived', color: 'var(--ink-4)' },
]
const statusColor = (s) => (STATUS_OPTIONS.find(o => o.id === s) || STATUS_OPTIONS[0]).color
const statusLabel = (s) => (STATUS_OPTIONS.find(o => o.id === s) || STATUS_OPTIONS[0]).label

const fmt$ = (n) => n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n || 0).toLocaleString()}`
const fmtN = (n) => Math.round(n || 0).toLocaleString()

export default function AdsTestingPanel() {
  const [angles, setAngles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState(null)

  // Per-angle aggregated metrics: { [angleId]: { spend, leads, ... } }
  const [metrics, setMetrics] = useState({})

  // All ads cache for the assignment picker. Loaded once when first
  // angle is expanded.
  const [adsCache, setAdsCache] = useState(null)

  // Days window for aggregate metrics. 30 by default to match the
  // Performance page's default view.
  const [days, setDays] = useState(30)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [{ data: a, error: aErr }, asg] = await Promise.all([
        supabase.from('ad_angles').select('*').order('created_at', { ascending: false }),
        pagedFetch(() => supabase.from('ad_angle_assignments').select('angle_id, ad_id, assigned_at')),
      ])
      if (aErr) throw new Error(aErr.message)
      const byAngle = {}
      for (const row of asg) {
        if (!byAngle[row.angle_id]) byAngle[row.angle_id] = []
        byAngle[row.angle_id].push(row.ad_id)
      }
      setAngles((a || []).map(x => ({ ...x, adIds: byAngle[x.id] || [] })))
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Stable signature for the metrics-fetch effect dependencies. Without
  // this, every setAngles call (verdict toggle, name edit, etc) creates
  // a new outer array + inner objects, refiring the heavy two-query
  // metrics fetch even when no assignments changed. Re-fires only when
  // an angle's ad_id list actually changes.
  const angleSignature = useMemo(
    () => angles.map(a => `${a.id}:${[...a.adIds].sort().join(',')}`).join('|'),
    [angles]
  )

  // Refetch aggregate metrics whenever the assigned-ads signature or the
  // selected window changes.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!angles.length) { setMetrics({}); return }
      const allAdIds = Array.from(new Set(angles.flatMap(a => a.adIds))).filter(Boolean)
      if (!allAdIds.length) { setMetrics({}); return }

      const since = new Date()
      since.setDate(since.getDate() - days)
      const sinceStr = since.toISOString().slice(0, 10)

      // Spend per ad in window
      const stats = await pagedFetch(() => supabase
        .from('ad_daily_stats')
        .select('ad_id, spend')
        .in('ad_id', allAdIds)
        .gte('date', sinceStr))
      const spendByAd = {}
      for (const r of stats) spendByAd[r.ad_id] = (spendByAd[r.ad_id] || 0) + parseFloat(r.spend || 0)

      // Per-ad typeform attribution (leads, booked, lives, closes, revenue).
      // lib_typeform_ad_attribution is rolled per ad_id with NO date filter
      // built into the view — these are all-time figures. The UI labels
      // every funnel metric as "all-time" so users don't confuse it with
      // the windowed spend. A future window-scoped variant would need a
      // SQL function (lib_typeform_ad_attribution_window(since)) since
      // the rollup happens server-side.
      //
      // pagedFetch wraps the query so we don't silently truncate at the
      // PostgREST 1000-row cap once the assigned-ad pool grows.
      const attr = await pagedFetch(() => supabase
        .from('lib_typeform_ad_attribution')
        .select('ad_id, leads, booked_calls, live_calls, closes, revenue_attributed, cash_attributed')
        .in('ad_id', allAdIds))
      const attrByAd = {}
      for (const r of attr) attrByAd[r.ad_id] = r

      if (cancelled) return
      const out = {}
      for (const ang of angles) {
        const agg = { spend: 0, leads: 0, booked: 0, live: 0, closes: 0, revenue: 0, cash: 0 }
        for (const adId of ang.adIds) {
          agg.spend   += spendByAd[adId] || 0
          const x = attrByAd[adId] || {}
          agg.leads   += x.leads          || 0
          agg.booked  += x.booked_calls   || 0
          agg.live    += x.live_calls     || 0
          agg.closes  += x.closes         || 0
          agg.revenue += parseFloat(x.revenue_attributed || 0)
          agg.cash    += parseFloat(x.cash_attributed    || 0)
        }
        out[ang.id] = agg
      }
      setMetrics(out)
    })().catch(e => !cancelled && setError(e.message))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- angleSignature is the stable proxy for angles
  }, [angleSignature, days])

  const loadAdsCacheIfNeeded = async () => {
    if (adsCache) return adsCache
    const ads = await pagedFetch(() => supabase
      .from('ads')
      .select('ad_id, ad_name, effective_status, campaign_name, thumbnail_url')
      .order('first_seen_at', { ascending: false }))
    setAdsCache(ads)
    return ads
  }

  const handleCreate = async (form) => {
    const { data, error } = await supabase.from('ad_angles').insert({
      name: form.name.trim(),
      label: form.label.trim() || null,
      hypothesis: form.hypothesis.trim() || null,
      status: 'testing',
      notes: null,
    }).select().single()
    if (error) { setError(error.message); return }
    setAngles(prev => [{ ...data, adIds: [] }, ...prev])
    setCreating(false)
    setExpandedId(data.id) // auto-open so Ben can immediately assign ads
  }

  const handleUpdate = async (id, patch) => {
    const { data, error } = await supabase.from('ad_angles').update(patch).eq('id', id).select().single()
    if (error) { setError(error.message); return }
    setAngles(prev => prev.map(a => a.id === id ? { ...a, ...data, adIds: a.adIds } : a))
  }

  // confirmingDeleteId: which angle (if any) is in the "are you sure?"
  // state. Inline two-click confirm — no native browser modal so we
  // stay in the editorial theme.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null)
  const handleDelete = async (id) => {
    if (confirmingDeleteId !== id) {
      setConfirmingDeleteId(id)
      // Auto-clear the confirm state after 5s if the user moves on.
      setTimeout(() => {
        setConfirmingDeleteId(curr => (curr === id ? null : curr))
      }, 5000)
      return
    }
    setConfirmingDeleteId(null)
    const { error } = await supabase.from('ad_angles').delete().eq('id', id)
    if (error) { setError(error.message); return }
    setAngles(prev => prev.filter(a => a.id !== id))
  }

  const handleAssign = async (angleId, adIds) => {
    if (!adIds.length) return
    const rows = adIds.map(ad_id => ({ angle_id: angleId, ad_id }))
    const { error } = await supabase.from('ad_angle_assignments').upsert(rows, { onConflict: 'angle_id,ad_id' })
    if (error) { setError(error.message); return }
    setAngles(prev => prev.map(a => a.id === angleId
      ? { ...a, adIds: Array.from(new Set([...a.adIds, ...adIds])) }
      : a))
  }

  const handleUnassign = async (angleId, adId) => {
    const { error } = await supabase.from('ad_angle_assignments').delete()
      .eq('angle_id', angleId).eq('ad_id', adId)
    if (error) { setError(error.message); return }
    setAngles(prev => prev.map(a => a.id === angleId
      ? { ...a, adIds: a.adIds.filter(x => x !== adId) }
      : a))
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button onClick={() => setCreating(c => !c)} style={btnPrimary}>
          <Plus size={13} /> {creating ? 'Cancel' : 'New angle'}
        </button>
        <span style={mono}>{angles.length} {angles.length === 1 ? 'angle' : 'angles'}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {[7, 30, 90, 730].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              ...btnGhost,
              background: days === d ? 'var(--ink)' : 'transparent',
              color: days === d ? 'var(--paper)' : 'var(--ink-3)',
            }}>{d === 730 ? '2y' : `${d}d`}</button>
          ))}
        </div>
      </div>
      {/* Windowing-semantics note. Spend pulls from ad_daily_stats within
          the selected window; the funnel metrics (leads/booked/live/closes/
          revenue/cash) come from lib_typeform_ad_attribution which is
          all-time per ad. That mismatch makes $/Lead and CAC drift smaller
          on shorter windows because the numerator shrinks while the
          denominator stays the same. Flag explicitly until we have a
          window-scoped view. */}
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 16 }}>
        Spend = window · Funnel metrics = all-time per ad. Use 2y for the most reconciled view.
      </div>

      {error && <div style={errorBanner}>{error}</div>}
      {creating && <NewAngleForm onCreate={handleCreate} onCancel={() => setCreating(false)} />}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} />
        </div>
      ) : angles.length === 0 ? (
        <div style={emptyState}>
          <p style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 15, color: 'var(--ink-3)' }}>
            No angles yet. Click <strong>New angle</strong> to start a hypothesis test —
            name the angle ("Time-poor owner" / "Stress hook" / "Big revenue claim"),
            give it a short label, then assign the creatives that test it.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {angles.map(angle => (
            <AngleCard
              key={angle.id}
              angle={angle}
              metrics={metrics[angle.id]}
              expanded={expandedId === angle.id}
              onToggle={() => setExpandedId(expandedId === angle.id ? null : angle.id)}
              onUpdate={(patch) => handleUpdate(angle.id, patch)}
              onDelete={() => handleDelete(angle.id)}
              confirmingDelete={confirmingDeleteId === angle.id}
              onAssign={(adIds) => handleAssign(angle.id, adIds)}
              onUnassign={(adId) => handleUnassign(angle.id, adId)}
              loadAdsCache={loadAdsCacheIfNeeded}
              adsCache={adsCache}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── New-angle form ─────────────────────────────────────────────────
function NewAngleForm({ onCreate, onCancel }) {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [hypothesis, setHypothesis] = useState('')
  const canSubmit = name.trim().length >= 2
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (canSubmit) onCreate({ name, label, hypothesis }) }}
      style={card}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 10 }}>
        <Field label="Angle name" required>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Stress-of-running-the-show"
            style={input} autoFocus />
        </Field>
        <Field label="Label">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="STRESS-01"
            style={input} />
        </Field>
      </div>
      <Field label="Hypothesis (optional)">
        <textarea value={hypothesis} onChange={e => setHypothesis(e.target.value)} rows={2}
          placeholder="What we expect this angle to prove. e.g. 'Restoration owners respond more to stress framing than to revenue claims because they're already drowning'"
          style={{ ...input, resize: 'vertical', minHeight: 50 }} />
      </Field>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="submit" disabled={!canSubmit} style={{ ...btnPrimary, opacity: canSubmit ? 1 : 0.5 }}>
          <Check size={13} /> Create angle
        </button>
        <button type="button" onClick={onCancel} style={btnGhost}>Cancel</button>
      </div>
    </form>
  )
}

// ── Angle card (collapsed + expanded states) ────────────────────────
function AngleCard({ angle, metrics, expanded, onToggle, onUpdate, onDelete, confirmingDelete, onAssign, onUnassign, loadAdsCache, adsCache }) {
  const m = metrics || { spend: 0, leads: 0, booked: 0, live: 0, closes: 0, revenue: 0, cash: 0 }
  const cpl  = m.leads  > 0 ? m.spend / m.leads  : 0
  const cpb  = m.booked > 0 ? m.spend / m.booked : 0
  const cac  = m.closes > 0 ? m.spend / m.closes : 0
  const roas = m.spend  > 0 ? m.cash / m.spend   : 0
  const headerStatus = statusLabel(angle.status)
  const headerColor  = statusColor(angle.status)

  return (
    <div style={{ ...card, padding: 0 }}>
      {/* Collapsed header */}
      <button onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 12,
        width: '100%', padding: '14px 16px', background: 'transparent',
        border: 'none', cursor: 'pointer', textAlign: 'left',
      }}>
        {expanded ? <ChevronDown size={15} style={{ color: 'var(--ink-3)' }} /> : <ChevronRight size={15} style={{ color: 'var(--ink-3)' }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>{angle.name}</span>
            {angle.label && <span style={labelChip}>{angle.label}</span>}
            <span style={{ ...statusPill, borderColor: headerColor, color: headerColor }}>{headerStatus}</span>
            <span style={{ ...mono, color: 'var(--ink-4)' }}>{angle.adIds.length} creative{angle.adIds.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 24, alignItems: 'baseline' }}>
          <Stat label="Spend"  value={fmt$(m.spend)} />
          <Stat label="Leads"  value={fmtN(m.leads)} />
          <Stat label="Booked" value={fmtN(m.booked)} />
          <Stat label="Live"   value={fmtN(m.live)} />
          <Stat label="Closes" value={fmtN(m.closes)} color={m.closes > 0 ? '#1f7a3a' : undefined} />
          <Stat label="CAC"    value={m.closes > 0 ? fmt$(cac) : '—'} />
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '0 16px 16px 36px', borderTop: '1px solid var(--rule-soft, rgba(0,0,0,0.06))' }}>
          {/* Verdict + Edit + Delete row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 0', flexWrap: 'wrap' }}>
            <span style={{ ...mono, marginRight: 4 }}>Status:</span>
            {STATUS_OPTIONS.map(opt => (
              <button key={opt.id} onClick={() => onUpdate({ status: opt.id })} style={{
                ...btnGhost,
                fontSize: 10,
                padding: '5px 10px',
                borderColor: angle.status === opt.id ? opt.color : 'var(--rule)',
                color: angle.status === opt.id ? opt.color : 'var(--ink-3)',
                fontWeight: angle.status === opt.id ? 600 : 500,
                background: angle.status === opt.id ? `${opt.color}11` : 'transparent',
              }}>{opt.label}</button>
            ))}
            <button onClick={onDelete} style={{
              ...btnGhost,
              marginLeft: 'auto',
              color: confirmingDelete ? '#fff' : '#b41e1e',
              background: confirmingDelete ? '#b41e1e' : 'transparent',
              borderColor: '#b41e1e',
            }}>
              <Trash2 size={12} /> {confirmingDelete ? 'Click again to confirm' : 'Delete'}
            </button>
          </div>

          {/* Hypothesis */}
          {angle.hypothesis && (
            <div style={{ padding: '10px 14px', background: 'var(--paper-2, rgba(0,0,0,0.02))', borderLeft: '2px solid var(--accent)', marginBottom: 12, borderRadius: 0 }}>
              <div style={{ ...mono, marginBottom: 4 }}>Hypothesis</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 13.5, fontStyle: 'italic', color: 'var(--ink)' }}>{angle.hypothesis}</div>
            </div>
          )}

          {/* Aggregate metrics + derived rates */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, padding: '8px 0 14px' }}>
            <BigStat label="Revenue"      value={fmt$(m.revenue)} accent />
            <BigStat label="Cash"         value={fmt$(m.cash)} />
            <BigStat label="$ / Lead"     value={cpl > 0 ? fmt$(cpl) : '—'} />
            <BigStat label="$ / Booked"   value={cpb > 0 ? fmt$(cpb) : '—'} />
            <BigStat label="CAC"          value={cac > 0 ? fmt$(cac) : '—'} />
            <BigStat label="Cash ROAS"    value={roas > 0 ? `${roas.toFixed(2)}x` : '—'} />
          </div>

          {/* Creatives */}
          <CreativeList
            adIds={angle.adIds}
            adsCache={adsCache}
            loadAdsCache={loadAdsCache}
            onAssign={onAssign}
            onUnassign={onUnassign}
          />
        </div>
      )}
    </div>
  )
}

// ── Creative list + picker ─────────────────────────────────────────
function CreativeList({ adIds, adsCache, loadAdsCache, onAssign, onUnassign }) {
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState(new Set())

  useEffect(() => {
    if (picking && !adsCache) loadAdsCache()
  }, [picking, adsCache, loadAdsCache])

  const assigned = useMemo(() => {
    if (!adsCache) return adIds.map(id => ({ ad_id: id }))
    const byId = Object.fromEntries(adsCache.map(a => [a.ad_id, a]))
    return adIds.map(id => byId[id] || { ad_id: id, ad_name: '(unknown ad)' })
  }, [adIds, adsCache])

  const candidates = useMemo(() => {
    if (!adsCache) return []
    const assignedSet = new Set(adIds)
    const q = search.trim().toLowerCase()
    return adsCache
      .filter(a => !assignedSet.has(a.ad_id))
      .filter(a => !q || `${a.ad_name || ''} ${a.campaign_name || ''}`.toLowerCase().includes(q))
      .slice(0, 50)
  }, [adsCache, adIds, search])

  const submitPick = () => {
    if (!picked.size) { setPicking(false); return }
    onAssign(Array.from(picked))
    setPicked(new Set())
    setPicking(false)
    setSearch('')
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={mono}>Creatives</span>
        <button onClick={() => setPicking(p => !p)} style={btnGhost}>
          <Plus size={11} /> {picking ? 'Cancel' : 'Add creative'}
        </button>
      </div>

      {picking && (
        <div style={{ ...card, padding: 10, marginBottom: 10 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by ad name or campaign…"
            style={{ ...input, marginBottom: 8 }}
            autoFocus
          />
          {!adsCache ? (
            <div style={{ padding: 12, textAlign: 'center' }}><Loader className="animate-spin" style={{ color: 'var(--ink-3)' }} /></div>
          ) : (
            <>
              <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--rule)', borderRadius: 9 }}>
                {candidates.length === 0 ? (
                  <div style={{ padding: 14, textAlign: 'center', fontStyle: 'italic', color: 'var(--ink-3)' }}>No matches</div>
                ) : candidates.map(ad => {
                  const isPicked = picked.has(ad.ad_id)
                  return (
                    <button
                      key={ad.ad_id}
                      onClick={() => {
                        const next = new Set(picked)
                        if (isPicked) next.delete(ad.ad_id); else next.add(ad.ad_id)
                        setPicked(next)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                        padding: '8px 10px', background: isPicked ? 'var(--accent-soft, rgba(244,225,74,0.18))' : 'transparent',
                        border: 'none', borderBottom: '1px solid var(--rule-soft, rgba(0,0,0,0.04))',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      {ad.thumbnail_url ? (
                        <img src={ad.thumbnail_url} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 9 }} />
                      ) : (
                        <div style={{ width: 36, height: 36, background: 'var(--paper-2)', borderRadius: 9 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ad.ad_name}</div>
                        <div style={{ ...mono, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ad.campaign_name} · {ad.effective_status}</div>
                      </div>
                      {isPicked && <Check size={14} style={{ color: 'var(--accent)' }} />}
                    </button>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={submitPick} disabled={!picked.size} style={{ ...btnPrimary, opacity: picked.size ? 1 : 0.5 }}>
                  Assign {picked.size > 0 && `(${picked.size})`}
                </button>
                <button onClick={() => { setPicking(false); setPicked(new Set()); setSearch('') }} style={btnGhost}>Cancel</button>
              </div>
            </>
          )}
        </div>
      )}

      {assigned.length === 0 ? (
        <div style={{ padding: 14, fontStyle: 'italic', color: 'var(--ink-3)', textAlign: 'center', border: '1px dashed var(--rule)', borderRadius: 9 }}>
          No creatives assigned yet. Click <strong>Add creative</strong> above.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {assigned.map(ad => (
            <div key={ad.ad_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, border: '1px solid var(--rule)', borderRadius: 9, background: 'var(--paper)' }}>
              {ad.thumbnail_url ? (
                <img src={ad.thumbnail_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 9 }} />
              ) : (
                <div style={{ width: 32, height: 32, background: 'var(--paper-2)', borderRadius: 9 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ad.ad_name || ad.ad_id}</div>
                <div style={{ ...mono, color: 'var(--ink-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 8.5 }}>{ad.campaign_name || ''}</div>
              </div>
              <button onClick={() => onUnassign(ad.ad_id)} style={{ background: 'transparent', border: 'none', color: 'var(--ink-4)', cursor: 'pointer', padding: 2 }} title="Remove from angle">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Small UI primitives ─────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ ...mono, marginBottom: 4 }}>{label}{required && <span style={{ color: '#b41e1e' }}> *</span>}</div>
      {children}
    </label>
  )
}
function Stat({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <span style={{ ...mono, color: 'var(--ink-4)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 600, color: color || 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
function BigStat({ label, value, accent }) {
  return (
    <div style={{ padding: '10px 12px', border: '1px solid var(--rule)', borderRadius: 9, background: 'var(--paper)' }}>
      <div style={{ ...mono, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 600, color: accent ? '#1f7a3a' : 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

const card = { background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 9, padding: 16 }
const input = {
  width: '100%', padding: '7px 10px', fontFamily: 'var(--serif)', fontSize: 14,
  background: 'var(--paper-2, rgba(0,0,0,0.02))', border: '1px solid var(--rule)', borderRadius: 9,
  color: 'var(--ink)', outline: 'none',
}
const mono = { fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 500 }
const btnPrimary = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 12px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
  textTransform: 'uppercase', fontWeight: 600,
  background: 'var(--accent)', color: 'var(--ink)', border: '1px solid var(--accent)', borderRadius: 9, cursor: 'pointer',
}
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '6px 11px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
  textTransform: 'uppercase', fontWeight: 500,
  background: 'transparent', color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: 9, cursor: 'pointer',
}
const labelChip = {
  padding: '2px 7px', fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
  background: 'var(--accent-soft, rgba(244,225,74,0.18))', border: '1px solid var(--accent)',
  borderRadius: 9, color: 'var(--ink)', fontWeight: 600,
}
const statusPill = {
  padding: '2px 7px', fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
  textTransform: 'uppercase', fontWeight: 600,
  background: 'transparent', border: '1px solid', borderRadius: 9,
}
const errorBanner = {
  padding: '10px 14px', marginBottom: 12,
  background: 'rgba(180,30,30,0.08)', border: '1px solid #b41e1e', borderRadius: 9,
  fontSize: 13, color: '#b41e1e',
}
const emptyState = {
  padding: 40, textAlign: 'center',
  border: '1px dashed var(--rule)', borderRadius: 9,
}
