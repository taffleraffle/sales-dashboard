import { useState, useMemo, useEffect } from 'react'
import { Phone, Target, TrendingUp, DollarSign, RotateCcw, Zap } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { useCloserEODs, useCloserStats } from '../hooks/useCloserData'
import { useCommissionSettings } from '../hooks/useCommissions'
import Select from '../components/editorial/Select'

/*
  Commission Forecast — a closer-facing planner. You set a monthly commission
  goal; it back-solves the activity you need: calls → closes → ascensions →
  PIFs. Every rate + payout is pre-filled from your real tracked stats (last
  90 days of EOD reports + your commission settings) and is editable, so it
  doubles as a what-if calculator ("if I lift my close rate to 45%…").

  The funnel (Ben 2026-07-01):
    live calls ──closeRate──▶ closes ──ascensionRate──▶ ascensions
                                                           │
                                              pifRate ─────┤─▶ PIFs (paid-in-full ascensions)
                                                           └─▶ monthly ascensions
  A PIF is an ascension paid in full upfront — a subset of ascensions that
  pays more cash + commission than a monthly ascension.

  Payout model mirrors services/commissionCalc.js: a closer earns
  commission_rate% on the trial close and ascension_rate% on the ascension
  (PIF = the full program collected upfront, so a bigger ascension payment).
  Here we expose the resulting $-per-event directly so the closer can tweak it.
*/

const WINDOW_DAYS = 90

// ── formatting helpers ──────────────────────────────────────────────────────
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')
const int = (n) => Math.max(0, Math.ceil(Number(n) || 0)).toLocaleString('en-US')
const one = (n) => (Number(n) || 0).toFixed(1)
const numOr = (v, fallback) => {
  if (v === '' || v === null || v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export default function CommissionForecast() {
  const { isAdmin, profile } = useAuth()

  // Closer roster — derive distinct closers from the EOD reports we already
  // load for stats, so we don't need a separate team_members fetch.
  const { reports: allReports, loading: rosterLoading } = useCloserEODs(null, WINDOW_DAYS)
  const closers = useMemo(() => {
    const m = new Map()
    for (const r of allReports) {
      if (r.closer_id && !m.has(r.closer_id)) m.set(r.closer_id, r.closer?.name || 'Closer')
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [allReports])

  // Non-admins are locked to themselves; admins pick.
  const [pickedId, setPickedId] = useState(null)
  const selectedId = isAdmin ? (pickedId || closers[0]?.id || null) : (profile?.teamMemberId || null)

  const stats = useCloserStats(selectedId, WINDOW_DAYS)
  const { settingsMap } = useCommissionSettings()
  const settings = selectedId ? settingsMap[selectedId] : null

  // ── Baselines pulled from real data (all editable via overrides) ──────────
  const baseline = useMemo(() => {
    const liveCalls = stats.liveCalls || 0
    const closes = stats.closes || 0
    const ascensions = stats.ascensions || 0          // EOD `deposits`
    const ascendCash = stats.ascendCash || 0
    const ascendRevenue = stats.ascendRevenue || 0
    const cash = stats.cash || 0

    const trialRate = numOr(settings?.commission_rate, 10)                       // %
    const ascComRate = numOr(settings?.ascension_rate, settings?.commission_rate) // %
    const ascComEff = Number.isFinite(ascComRate) ? ascComRate : 5

    // Per-event cash (fall back to sensible defaults for a closer with no
    // history yet, so the calculator still works).
    const trialCash = closes > 0 ? Math.max(0, cash - ascendCash) / closes : 2000
    const ascCash = ascensions > 0 ? ascendCash / ascensions : 1500
    const pifValue = ascensions > 0 && ascendRevenue > 0 ? ascendRevenue / ascensions : ascCash * 6

    return {
      closeRate: liveCalls > 0 ? (closes / liveCalls) * 100 : 25,      // closes ÷ live calls
      ascRate: closes > 0 ? (ascensions / closes) * 100 : 30,          // ascensions ÷ closes
      pifRate: 30,                                                     // no per-closer PIF tracking → assumption
      commClose: trialCash * (numOr(trialRate, 10) / 100),            // $ per trial close
      commAsc: ascCash * (ascComEff / 100),                           // $ per monthly ascension
      commPif: pifValue * (ascComEff / 100),                          // $ per PIF
      // raw window snapshot (for the "how it's tracking" strip + on-track calc)
      _liveCalls: liveCalls, _closes: closes, _ascensions: ascensions,
    }
  }, [stats, settings])

  // ── Editable overrides. Cleared whenever the selected closer changes so we
  //    re-seed from their baseline. Goal + working days persist. ─────────────
  const [ovr, setOvr] = useState({})
  const [goalStr, setGoalStr] = useState('')
  const [workDaysStr, setWorkDaysStr] = useState('22')
  useEffect(() => { setOvr({}) }, [selectedId])

  const eff = (key) => numOr(ovr[key], baseline[key])
  const set = (key) => (v) => setOvr((p) => ({ ...p, [key]: v }))
  const touched = Object.keys(ovr).some((k) => ovr[k] !== '' && ovr[k] !== undefined)

  // Default the goal to a round number above current pace once stats land.
  const monthlyFactor = 30 / WINDOW_DAYS
  const curCommMo = useMemo(() => {
    const ePif = eff('pifRate') / 100
    return (baseline._closes * baseline.commClose +
            baseline._ascensions * ((1 - ePif) * baseline.commAsc + ePif * baseline.commPif)) * monthlyFactor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, ovr])
  useEffect(() => {
    if (goalStr === '' && (baseline._closes > 0 || baseline._ascensions > 0)) {
      const seed = Math.max(5000, Math.round((curCommMo * 1.25) / 500) * 500)
      setGoalStr(String(seed))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline._closes, baseline._ascensions])

  // ── The forecast math ─────────────────────────────────────────────────────
  const f = useMemo(() => {
    const goal = numOr(goalStr, 0)
    const workDays = Math.max(1, numOr(workDaysStr, 22))
    const closeRate = eff('closeRate') / 100
    const ascRate = eff('ascRate') / 100
    const pifRate = eff('pifRate') / 100
    const Ct = eff('commClose')
    const Cm = eff('commAsc')
    const Cp = eff('commPif')

    // commission earned per live call, cascading down the funnel
    const commPerCall =
      closeRate * Ct +
      closeRate * ascRate * ((1 - pifRate) * Cm + pifRate * Cp)

    const solvable = goal > 0 && commPerCall > 0
    const calls = solvable ? goal / commPerCall : 0
    const closes = calls * closeRate
    const ascensions = closes * ascRate
    const pifs = ascensions * pifRate
    const monthlyAsc = ascensions * (1 - pifRate)

    return {
      goal, workDays, commPerCall, solvable,
      calls, closes, ascensions, pifs, monthlyAsc,
      callsPerDay: calls / workDays,
      projClose: closes * Ct,
      projAsc: monthlyAsc * Cm,
      projPif: pifs * Cp,
    }
  }, [goalStr, workDaysStr, ovr, baseline]) // eslint-disable-line react-hooks/exhaustive-deps

  const projTotal = f.projClose + f.projAsc + f.projPif

  // Current monthly pace vs what's required (the "am I on track?" read).
  const pace = useMemo(() => {
    const ePif = eff('pifRate') / 100
    return {
      calls: baseline._liveCalls * monthlyFactor,
      closes: baseline._closes * monthlyFactor,
      ascensions: baseline._ascensions * monthlyFactor,
      pifs: baseline._ascensions * ePif * monthlyFactor,
      commission: curCommMo,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, ovr, curCommMo])

  const loading = rosterLoading || (isAdmin && !selectedId)

  return (
    <div style={{ padding: '28px 32px 64px', maxWidth: 1180, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <span className="eyebrow eyebrow-accent" style={{ fontSize: 9.5 }}>Commission planner</span>
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: 40, fontWeight: 400, lineHeight: 1.1, letterSpacing: '0.005em', color: 'var(--ink)', marginTop: 8 }}>
            Commission Forecast
          </h1>
          <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 6, maxWidth: 560, lineHeight: 1.6 }}>
            Set a monthly commission goal and see exactly how many calls, closes, ascensions and PIFs it takes.
            Every number is seeded from your last {WINDOW_DAYS} days — edit any of them to model a change.
          </p>
        </div>
        {isAdmin && closers.length > 0 && (
          <div>
            <span className="eyebrow" style={{ fontSize: 8.5, marginBottom: 6, display: 'inline-flex' }}>Closer</span>
            <Select
              value={selectedId || ''}
              onChange={setPickedId}
              options={closers.map((c) => ({ value: c.id, label: c.name }))}
              placeholder="Pick a closer"
              minWidth={190}
            />
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 12 }}>
          Loading your stats…
        </div>
      ) : !selectedId ? (
        <div style={panelStyle}>
          <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>No closer profile linked to this account yet — ask an admin to connect you, then this will fill in automatically.</p>
        </div>
      ) : (
        <>
          {/* Tracked snapshot — the "how it's tracking" read */}
          <div style={{ ...panelStyle, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span className="eyebrow" style={{ fontSize: 9 }}>Your last {WINDOW_DAYS} days · tracked</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)', letterSpacing: '0.06em' }}>
                {money(pace.commission)}/mo pace
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 1, background: 'var(--rule)', border: '1px solid var(--rule)', borderRadius: 8, overflow: 'hidden' }}>
              <Snap label="Live calls" value={int(baseline._liveCalls)} />
              <Snap label="Closes" value={int(baseline._closes)} />
              <Snap label="Ascensions" value={int(baseline._ascensions)} />
              <Snap label="Close rate" value={one(baseline.closeRate) + '%'} />
              <Snap label="Ascension rate" value={one(baseline.ascRate) + '%'} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 340px) 1fr', gap: 20, alignItems: 'start' }}>
            {/* LEFT — inputs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Goal */}
              <div style={{ ...panelStyle, background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
                <span className="eyebrow" style={{ fontSize: 9, marginBottom: 10, display: 'inline-flex' }}>Your goal</span>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', display: 'block', marginBottom: 6 }}>
                  Monthly commission target
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', fontSize: 15, fontFamily: 'var(--serif)' }}>$</span>
                  <input type="number" inputMode="numeric" value={goalStr} onChange={(e) => setGoalStr(e.target.value)}
                    placeholder="10,000"
                    style={{ ...inputStyle, paddingLeft: 24, fontSize: 20, fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums', height: 46 }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <label style={{ fontSize: 11, color: 'var(--ink-3)' }}>Working days / month</label>
                  <input type="number" inputMode="numeric" value={workDaysStr} onChange={(e) => setWorkDaysStr(e.target.value)}
                    style={{ ...inputStyle, width: 62, height: 30, padding: '4px 8px', fontSize: 12 }} />
                </div>
              </div>

              {/* Funnel rates */}
              <div style={panelStyle}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span className="eyebrow" style={{ fontSize: 9 }}>Your funnel rates</span>
                  {touched && (
                    <button onClick={() => setOvr({})} title="Reset every assumption to your tracked stats"
                      style={resetBtn}><RotateCcw size={11} /> Reset</button>
                  )}
                </div>
                <Field label="Close rate" hint="closes ÷ live calls" suffix="%" value={ovr.closeRate} baseline={baseline.closeRate} onChange={set('closeRate')} fmtBase={one} />
                <Field label="Ascension rate" hint="ascensions ÷ closes" suffix="%" value={ovr.ascRate} baseline={baseline.ascRate} onChange={set('ascRate')} fmtBase={one} />
                <Field label="PIF rate" hint="paid-in-full ÷ ascensions" suffix="%" value={ovr.pifRate} baseline={baseline.pifRate} onChange={set('pifRate')} fmtBase={one} last />
              </div>

              {/* Payout per event */}
              <div style={panelStyle}>
                <span className="eyebrow" style={{ fontSize: 9, marginBottom: 12, display: 'inline-flex' }}>Your commission per deal</span>
                <Field label="Per trial close" prefix="$" value={ovr.commClose} baseline={baseline.commClose} onChange={set('commClose')} fmtBase={(n) => Math.round(n)} />
                <Field label="Per monthly ascension" prefix="$" value={ovr.commAsc} baseline={baseline.commAsc} onChange={set('commAsc')} fmtBase={(n) => Math.round(n)} />
                <Field label="Per PIF" hint="ascension paid in full" prefix="$" value={ovr.commPif} baseline={baseline.commPif} onChange={set('commPif')} fmtBase={(n) => Math.round(n)} last />
              </div>
            </div>

            {/* RIGHT — results */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {!f.solvable ? (
                <div style={{ ...panelStyle, textAlign: 'center', padding: 40 }}>
                  <p style={{ color: 'var(--ink-3)', fontSize: 13, lineHeight: 1.6 }}>
                    {f.goal <= 0
                      ? 'Enter a monthly commission goal to see the activity you need.'
                      : 'Your commission-per-deal is $0 — set your per-deal payouts so the forecast can solve.'}
                  </p>
                </div>
              ) : (
                <>
                  {/* Headline: what you need to DO */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                    <Out icon={Phone} tone="accent" label="Live calls / month" value={int(f.calls)}
                      sub={`${one(f.callsPerDay)} per working day`} />
                    <Out icon={Target} label="Closes / month" value={int(f.closes)}
                      sub={`at ${one(eff('closeRate'))}% close rate`} />
                    <Out icon={TrendingUp} label="Ascensions / month" value={int(f.ascensions)}
                      sub={`${int(f.monthlyAsc)} monthly · ${int(f.pifs)} PIF`} />
                    <Out icon={Zap} label="PIFs / month" value={int(f.pifs)}
                      sub={`at ${one(eff('pifRate'))}% of ascensions`} />
                  </div>

                  {/* Commission composition */}
                  <div style={panelStyle}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                      <span className="eyebrow" style={{ fontSize: 9 }}>Projected commission</span>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
                        {money(projTotal)}<span style={{ fontSize: 12, color: 'var(--ink-4)' }}>/mo</span>
                      </span>
                    </div>
                    <StackBar parts={[
                      { label: 'Trial closes', value: f.projClose, color: 'var(--ink)' },
                      { label: 'Ascensions', value: f.projAsc, color: '#c9a227' },
                      { label: 'PIFs', value: f.projPif, color: 'var(--accent)' },
                    ]} total={projTotal} />
                  </div>

                  {/* On-track vs current pace */}
                  <div style={panelStyle}>
                    <span className="eyebrow" style={{ fontSize: 9, marginBottom: 12, display: 'inline-flex' }}>Are you on track?</span>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--rule)' }}>
                          <th style={thStyle}></th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Now / mo</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Needed / mo</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Gap</th>
                        </tr>
                      </thead>
                      <tbody>
                        <PaceRow label="Live calls" now={pace.calls} need={f.calls} />
                        <PaceRow label="Closes" now={pace.closes} need={f.closes} />
                        <PaceRow label="Ascensions" now={pace.ascensions} need={f.ascensions} />
                        <PaceRow label="PIFs" now={pace.pifs} need={f.pifs} />
                        <PaceRow label="Commission" now={pace.commission} need={f.goal} money last />
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/* ── small presentational pieces ─────────────────────────────────────────── */

const panelStyle = { background: 'var(--paper)', border: '1px solid var(--rule)', borderRadius: 12, padding: 18, boxShadow: 'var(--shadow-card)' }
const inputStyle = { width: '100%', background: '#fff', border: '1px solid var(--rule)', borderRadius: 8, padding: '9px 12px', fontSize: 13, color: 'var(--ink)', fontFamily: 'var(--sans)', outline: 'none', appearance: 'textfield' }
const thStyle = { fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-4)', padding: '0 0 8px', textAlign: 'left' }
const resetBtn = { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent', border: '1px solid var(--rule)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-3)', cursor: 'pointer' }

function Snap({ label, value }) {
  return (
    <div style={{ background: 'var(--paper)', padding: '12px 14px' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 21, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
    </div>
  )
}

function Field({ label, hint, suffix, prefix, value, baseline, onChange, fmtBase = (n) => n, last }) {
  return (
    <div style={{ marginBottom: last ? 0 : 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 5 }}>
        <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-2)' }}>{label}</label>
        {hint && <span style={{ fontSize: 9.5, color: 'var(--ink-4)', fontStyle: 'italic' }}>{hint}</span>}
      </div>
      <div style={{ position: 'relative' }}>
        {prefix && <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', fontSize: 12 }}>{prefix}</span>}
        <input type="number" inputMode="decimal" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          placeholder={String(fmtBase(baseline))}
          style={{ ...inputStyle, paddingLeft: prefix ? 22 : 12, paddingRight: suffix ? 26 : 12, fontVariantNumeric: 'tabular-nums' }} />
        {suffix && <span style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-4)', fontSize: 12 }}>{suffix}</span>}
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--ink-4)', marginTop: 4, letterSpacing: '0.04em' }}>
        now: {prefix || ''}{fmtBase(baseline)}{suffix || ''}
      </div>
    </div>
  )
}

function Out({ icon: Icon, label, value, sub, tone }) {
  const accent = tone === 'accent'
  return (
    <div style={{ background: accent ? 'var(--ink)' : 'var(--paper)', border: `1px solid ${accent ? 'var(--ink)' : 'var(--rule)'}`, borderRadius: 12, padding: 18, boxShadow: 'var(--shadow-card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <Icon size={14} style={{ color: accent ? 'var(--accent)' : 'var(--ink-4)' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent ? 'rgba(255,255,255,0.7)' : 'var(--ink-4)' }}>{label}</span>
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 38, lineHeight: 1, color: accent ? '#fff' : 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: accent ? 'rgba(255,255,255,0.6)' : 'var(--ink-3)', marginTop: 7 }}>{sub}</div>}
    </div>
  )
}

function StackBar({ parts, total }) {
  const safe = total > 0 ? total : 1
  return (
    <div>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--rule)' }}>
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${Math.max(0, (p.value / safe) * 100)}%`, background: p.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        {parts.map((p) => (
          <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: p.color }} />
            <span style={{ fontSize: 11, color: 'var(--ink-2)' }}>{p.label}</span>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{money(p.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PaceRow({ label, now, need, money: isMoney, last }) {
  const fmt = isMoney ? money : int
  const gap = need - now
  const onTrack = gap <= 0.5
  return (
    <tr style={{ borderBottom: last ? 'none' : '1px solid var(--rule)' }}>
      <td style={{ padding: '10px 0', fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>{label}</td>
      <td style={{ padding: '10px 0', textAlign: 'right', fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' }}>{fmt(now)}</td>
      <td style={{ padding: '10px 0', textAlign: 'right', fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{fmt(need)}</td>
      <td style={{ padding: '10px 0', textAlign: 'right' }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          color: onTrack ? 'var(--up)' : 'var(--down)',
        }}>
          {onTrack ? '✓ on track' : `+${fmt(gap)}`}
        </span>
      </td>
    </tr>
  )
}
