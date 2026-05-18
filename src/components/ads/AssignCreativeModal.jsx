import { useEffect, useState, useMemo } from 'react'
import { X, Check, AlertCircle, Search, Link2, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { listGeneratedScripts, linkScriptToAd } from '../../services/scriptGenerator'

/*
  Assign Creative Modal — links a generated_script row to a real Meta ad_id.

  Two-step flow:
    1. Pick a script (filtered to status='draft' by default — already-linked
       scripts hidden)
    2. Search/pick a Meta ad (by name, with showing-most-recent ads first)
    3. Confirm → linkScriptToAd() propagates target_attributes to
       creative_attributes for the chosen ad_id, marks the script as 'shipped'

  Mounted from a top-right button on both Insights and Generator pages.
*/

export default function AssignCreativeModal({ open, onClose, onLinked, presetScript }) {
  const [step, setStep] = useState(1)  // 1=pick script, 2=pick ad
  const [scripts, setScripts] = useState([])
  const [chosenScript, setChosenScript] = useState(null)
  const [adQuery, setAdQuery] = useState('')
  const [ads, setAds] = useState([])
  const [chosenAd, setChosenAd] = useState(null)
  const [loading, setLoading] = useState(false)
  const [linking, setLinking] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) return
    setStep(presetScript ? 2 : 1)
    setErr(null)
    if (presetScript) {
      setChosenScript(presetScript)
    } else {
      setChosenScript(null)
    }
    setChosenAd(null); setAdQuery('')
    // Load both lists in parallel
    setLoading(true)
    Promise.all([
      listGeneratedScripts({ limit: 50 }),
      // Recent ads, prefer non-linked
      supabase.from('ads')
        .select('ad_id, ad_name, campaign_name, last_synced_at')
        .order('last_synced_at', { ascending: false, nullsFirst: false })
        .limit(100),
    ])
      .then(([s, a]) => {
        setScripts(s.filter(x => x.status !== 'shipped'))
        setAds(a.data || [])
      })
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }, [open, presetScript])

  const filteredAds = useMemo(() => {
    const q = adQuery.trim().toLowerCase()
    if (!q) return ads.slice(0, 30)
    return ads.filter(a =>
      (a.ad_name || '').toLowerCase().includes(q) ||
      (a.campaign_name || '').toLowerCase().includes(q) ||
      (a.ad_id || '').toLowerCase().includes(q)
    ).slice(0, 30)
  }, [ads, adQuery])

  if (!open) return null

  async function handleLink() {
    if (!chosenScript || !chosenAd) return
    setLinking(true); setErr(null)
    try {
      const result = await linkScriptToAd(chosenScript.id, chosenAd.ad_id)
      onLinked?.(result)
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setLinking(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,10,10,0.5)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--paper)', maxWidth: 760, width: '100%', maxHeight: '90vh',
          overflow: 'hidden', border: '2px solid var(--ink)', borderRadius: 2,
          boxShadow: '8px 8px 0 var(--accent)',
          display: 'flex', flexDirection: 'column',
        }}>
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                      flexShrink: 0 }}>
          <div>
            <div className="eyebrow eyebrow-accent">Link creative · step {step} of 2</div>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, fontWeight: 400, margin: '6px 0 0' }}>
              {step === 1 ? 'Pick the script' : <>Pick the Meta ad for <em>"{chosenScript?.title || 'this script'}"</em></>}
            </h2>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none', color: 'var(--ink-3)', cursor: 'pointer', padding: 4,
          }}>
            <X size={20} />
          </button>
        </div>

        {/* Step bar */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--rule)' }}>
          <StepIndicator num={1} label="Script" active={step === 1} done={step > 1} onClick={() => setStep(1)} />
          <StepIndicator num={2} label="Meta ad" active={step === 2} done={false}
            onClick={() => chosenScript && setStep(2)} disabled={!chosenScript} />
        </div>

        {err && (
          <div style={{ margin: 16, padding: 12, background: '#fef2f2', border: '1px solid #fca5a5',
                        color: '#b53e3e', fontSize: 13, borderRadius: 2 }}>
            <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          {step === 1 && (
            <div>
              <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--ink-3)',
                          fontSize: 13, margin: '0 0 16px' }}>
                Already-shipped scripts are hidden. Pick the draft you filmed.
              </p>
              {loading ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)',
                              fontStyle: 'italic', fontFamily: 'var(--serif)' }}>Loading drafts…</div>
              ) : scripts.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)',
                              fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
                  No drafts yet. Generate some on the Generate tab first.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {scripts.map(s => (
                    <button key={s.id}
                      onClick={() => { setChosenScript(s); setStep(2) }}
                      style={{
                        textAlign: 'left', padding: '12px 16px',
                        background: chosenScript?.id === s.id ? 'var(--ink)' : 'white',
                        color: chosenScript?.id === s.id ? 'var(--paper)' : 'var(--ink)',
                        border: `1px solid ${chosenScript?.id === s.id ? 'var(--ink)' : 'var(--rule)'}`,
                        borderRadius: 2, cursor: 'pointer',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
                      }}>
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div style={{ fontFamily: 'var(--serif)', fontSize: 15, marginBottom: 2 }}>
                          {s.title || '(untitled)'}
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10,
                                      color: chosenScript?.id === s.id ? 'var(--accent)' : 'var(--ink-4)',
                                      letterSpacing: '0.06em' }}>
                          {s.offer_slug?.replace('opt-', '')} · {s.frame} · created {new Date(s.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <FileText size={16} style={{ flexShrink: 0,
                        color: chosenScript?.id === s.id ? 'var(--accent)' : 'var(--ink-4)' }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div>
              <div style={{ position: 'relative', marginBottom: 12 }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--ink-4)' }} />
                <input type="text" value={adQuery} onChange={e => setAdQuery(e.target.value)}
                  placeholder="Search by ad name, campaign, or ID…"
                  style={{
                    width: '100%', padding: '10px 12px 10px 34px', fontFamily: 'var(--sans)',
                    fontSize: 14, border: '1px solid var(--rule)', background: 'white',
                    borderRadius: 2,
                  }} />
              </div>
              {loading ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)',
                              fontStyle: 'italic', fontFamily: 'var(--serif)' }}>Loading ads…</div>
              ) : filteredAds.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-4)',
                              fontStyle: 'italic', fontFamily: 'var(--serif)' }}>
                  No ads match {adQuery ? `"${adQuery}"` : 'this filter'}.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 4 }}>
                  {filteredAds.map(a => (
                    <button key={a.ad_id}
                      onClick={() => setChosenAd(a)}
                      style={{
                        textAlign: 'left', padding: '10px 14px',
                        background: chosenAd?.ad_id === a.ad_id ? 'var(--ink)' : 'white',
                        color: chosenAd?.ad_id === a.ad_id ? 'var(--paper)' : 'var(--ink)',
                        border: `1px solid ${chosenAd?.ad_id === a.ad_id ? 'var(--ink)' : 'var(--rule)'}`,
                        borderRadius: 2, cursor: 'pointer',
                      }}>
                      <div style={{ fontFamily: 'var(--sans)', fontSize: 13, fontWeight: 500,
                                    marginBottom: 2 }}>
                        {a.ad_name || a.ad_id}
                      </div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 10,
                                    color: chosenAd?.ad_id === a.ad_id ? 'var(--accent)' : 'var(--ink-4)',
                                    letterSpacing: '0.06em' }}>
                        {a.campaign_name || '(no campaign)'} · {a.ad_id}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--rule)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      flexShrink: 0, background: 'var(--paper)' }}>
          <div style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--ink-4)' }}>
            {chosenScript && chosenAd
              ? <>Will tag <strong style={{ color: 'var(--ink)' }}>{chosenAd.ad_name || chosenAd.ad_id}</strong> with script attributes</>
              : 'Pick both a script and an ad to link them'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose}
              style={{ padding: '10px 18px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: '1px solid var(--rule)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 2 }}>
              Cancel
            </button>
            <button onClick={handleLink} disabled={!chosenScript || !chosenAd || linking}
              style={{ padding: '10px 22px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                      border: '2px solid var(--ink)', background: 'var(--ink)',
                      color: 'var(--paper)', cursor: linking ? 'wait' : 'pointer',
                      opacity: (!chosenScript || !chosenAd) ? 0.4 : 1, borderRadius: 2,
                      boxShadow: (chosenScript && chosenAd && !linking) ? '3px 3px 0 var(--accent)' : 'none' }}>
              <Link2 size={12} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />
              {linking ? 'Linking…' : 'Link them'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function StepIndicator({ num, label, active, done, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        flex: 1, padding: '14px 16px', background: active ? 'white' : 'var(--paper)',
        border: 'none', borderRight: num === 1 ? '1px solid var(--rule)' : 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
        textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
      <span style={{
        width: 24, height: 24, borderRadius: 12, fontFamily: 'var(--mono)', fontWeight: 700,
        fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: done ? 'var(--accent)' : active ? 'var(--ink)' : 'var(--rule)',
        color: done ? 'var(--ink)' : active ? 'var(--paper)' : 'var(--ink-4)',
        border: active && !done ? '1px solid var(--ink)' : 'none',
      }}>{done ? <Check size={12} /> : num}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em',
                    textTransform: 'uppercase', fontWeight: 600,
                    color: active || done ? 'var(--ink)' : 'var(--ink-4)' }}>
        {label}
      </span>
    </button>
  )
}
