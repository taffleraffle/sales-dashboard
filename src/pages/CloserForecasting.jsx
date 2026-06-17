import { useState, useMemo, useEffect, useRef } from 'react'
import { Calculator, RotateCcw, Loader } from 'lucide-react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import { useTeamMembers } from '../hooks/useTeamMembers'
import { useCloserStats, useCloserEODs } from '../hooks/useCloserData'
import { supabase } from '../lib/supabase'
import { rangeToDays } from '../lib/dateUtils'
import { forecast } from '../services/forecastCalc'

const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

// ── formatters ──────────────────────────────────────────────────────────
const money = (n) => Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : '—'
const whole = (n) => Number.isFinite(n) ? Math.ceil(n).toLocaleString() : '—'
const oneDp = (n) => Number.isFinite(n) ? n.toFixed(1) : '—'
const pctStr = (n) => Number.isFinite(n) ? `${n.toFixed(1)}%` : '—'

export default function CloserForecasting() {
  const [range, setRange] = useState(30)
  const days = typeof range === 'number' ? range : (range === 'mtd' ? 30 : rangeToDays(range))

  const { members: closers, loading: loadingMembers } = useTeamMembers('closer')
  const [closerId, setCloserId] = useState(null)
  // Default to the first closer once the list lands.
  useEffect(() => {
    if (!closerId && closers && closers.length) setCloserId(closers[0].id)
  }, [closers, closerId])

  const stats = useCloserStats(closerId, days)
  const { reports: allReports } = useCloserEODs(null, days)   // company-wide, for cost/call defaults

  // commission_settings for the selected closer (rates + pay model)
  const [settings, setSettings] = useState(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  useEffect(() => {
    if (!closerId) return
    let alive = true
    setSettingsLoaded(false)
    supabase.from('commission_settings').select('*').eq('member_id', closerId).maybeSingle()
      .then(({ data }) => { if (alive) { setSettings(data || {}); setSettingsLoaded(true) } })
    return () => { alive = false }
  }, [closerId])

  // Company ad spend over the window → company cost-per-call defaults.
  const [spendUSD, setSpendUSD] = useState(null)
  useEffect(() => {
    let alive = true
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    supabase.from('ad_daily_stats').select('spend').gte('date', since)
      .then(({ data }) => {
        if (!alive) return
        const nzd = (data || []).reduce((s, r) => s + parseFloat(r.spend || 0), 0)
        setSpendUSD(nzd * NZD_TO_USD)
      })
    return () => { alive = false }
  }, [days])

  // Company booked / live totals (for cost-per-call denominators).
  const companyFunnel = useMemo(() => {
    let booked = 0, live = 0
    for (const r of (allReports || [])) {
      booked += (r.nc_booked || 0)
      live += (r.live_nc_calls || 0)
    }
    return { booked, live }
  }, [allReports])

  const monthlyScale = 30 / days

  // ── Default levers, seeded from the closer's real data ────────────────
  const defaults = useMemo(() => {
    const closeRate = parseFloat(stats.closeRate) || 25
    const showRate = parseFloat(stats.showRate) || 65
    const avgDeal = stats.closes > 0 ? Math.round(stats.revenue / stats.closes) : 2000
    const ascendRate = stats.closes > 0 ? Math.min(100, Math.round((stats.ascensions / stats.closes) * 100)) : 40
    const costPerBooked = spendUSD != null && companyFunnel.booked > 0
      ? Math.round(spendUSD / companyFunnel.booked) : 100
    const costPerLive = spendUSD != null && companyFunnel.live > 0
      ? Math.round(spendUSD / companyFunnel.live) : 150
    return {
      closeRate, showRate,
      trialValue: avgDeal,
      monthlyValue: 1500,
      ascendRate,
      lifetimeMonths: 6,
      commissionRate: settings?.commission_rate ?? 10,
      ascensionRate: settings?.ascension_rate ?? settings?.commission_rate ?? 5,
      baseSalary: settings?.base_salary ?? 0,
      rampAmount: settings?.ramp_amount ?? 0,
      payType: settings?.pay_type ?? 'base',
      costPerBookedCall: costPerBooked,
      costPerLiveCall: costPerLive,
    }
  }, [stats.closeRate, stats.showRate, stats.closes, stats.revenue, stats.ascensions, settings, spendUSD, companyFunnel.booked, companyFunnel.live])

  const defaultsReady = settingsLoaded && spendUSD != null

  // Lever state — seeded from defaults, then editable. Re-seed when the
  // closer changes (once that closer's defaults are ready) so switching
  // closers loads their real numbers; manual edits persist until then.
  const [levers, setLevers] = useState(null)
  const [target, setTarget] = useState(10000)   // monthly take-home goal
  const seededFor = useRef(null)
  useEffect(() => {
    if (defaultsReady && seededFor.current !== closerId) {
      setLevers(defaults)
      seededFor.current = closerId
    }
  }, [defaultsReady, closerId, defaults])

  const set = (k) => (v) => setLevers((L) => ({ ...L, [k]: v }))
  const resetToActuals = () => setLevers(defaults)

  const result = useMemo(() => {
    if (!levers) return null
    return forecast({
      ...levers,
      targetTakeHome: target,
      currentCloses: stats.closes * monthlyScale,
      currentLiveCalls: stats.liveNC * monthlyScale,
      currentBookedCalls: stats.ncBooked * monthlyScale,
    })
  }, [levers, target, stats.closes, stats.liveNC, stats.ncBooked, monthlyScale])

  const closer = closers?.find((c) => c.id === closerId)

  if (loadingMembers) {
    return (
      <div className="max-w-[1400px] mx-auto flex items-center justify-center py-32 text-text-400">
        <Loader className="animate-spin" size={20} />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Forecasting</span>
          <h1 className="h2 mt-2">Forecast your <em>commissions</em>.</h1>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={closerId || ''}
            onChange={(e) => setCloserId(e.target.value)}
            className="text-sm font-semibold rounded-sm px-3 py-2"
            style={{ background: 'var(--paper)', border: '1px solid var(--rule)', color: 'var(--ink)' }}
          >
            {(closers || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <DateRangeSelector selected={range} onChange={setRange} />
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto">
        {/* Current stats — the closer's real numbers in the window */}
        <div className="flex items-center gap-2 mb-3">
          <Calculator size={14} style={{ color: 'var(--ink-4)' }} />
          <h2 className="text-sm font-medium text-text-secondary">
            {closer?.name || '—'} · current stats <span className="text-text-400">(last {days}d)</span>
          </h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 sm:gap-3 mb-7">
          <KPICard label="Close Rate" value={`${stats.closeRate}%`} />
          <KPICard label="Show Rate" value={`${stats.showRate}%`} />
          <KPICard label="Cost / Booked Call" value={money(levers?.costPerBookedCall)} subtitle="company avg" />
          <KPICard label="Cost / Live Call" value={money(levers?.costPerLiveCall)} subtitle="company avg" />
          <KPICard label="Closes" value={stats.closes} subtitle={`${days}d`} />
          <KPICard label="Avg Deal" value={money(stats.closes > 0 ? stats.revenue / stats.closes : 0)} />
        </div>

        {!levers ? (
          <div className="tile tile-feedback p-10 text-center text-text-400">
            <Loader className="animate-spin inline mr-2" size={16} /> Loading {closer?.name || 'closer'}'s numbers…
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* ── LEFT: inputs ── */}
            <div className="space-y-5">
              {/* Goal */}
              <div className="tile tile-feedback p-5">
                <div className="eyebrow mb-3" style={{ fontSize: 10 }}>Your goal</div>
                <label className="block text-sm font-semibold mb-2 text-text-primary">
                  How much do you want to make <span className="text-text-400">/ month?</span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-2xl" style={{ fontFamily: 'var(--serif)', color: 'var(--ink-3)' }}>$</span>
                  <input
                    type="number" min={0} step={500} value={target}
                    onChange={(e) => setTarget(parseFloat(e.target.value) || 0)}
                    className="w-full text-2xl font-bold rounded-sm px-3 py-2"
                    style={{ background: 'var(--paper)', border: '1px solid var(--rule)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontVariantNumeric: 'tabular-nums' }}
                  />
                </div>
                <div className="mt-2 text-[11px] text-text-400">
                  Total take-home. {levers.payType === 'ramp'
                    ? `Ramp floor $${Number(levers.rampAmount).toLocaleString()} is guaranteed; commission only matters above it.`
                    : `Base salary $${Number(levers.baseSalary).toLocaleString()} + commission.`}
                </div>
              </div>

              {/* Funnel levers */}
              <div className="tile tile-feedback p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="eyebrow" style={{ fontSize: 10 }}>Funnel rates</div>
                  <button onClick={resetToActuals} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-400 hover:text-text-primary">
                    <RotateCcw size={11} /> Reset to actuals
                  </button>
                </div>
                <Slider label="Show rate" suffix="%" min={1} max={100} value={levers.showRate} onChange={set('showRate')} />
                <Slider label="Close rate" suffix="%" min={1} max={100} value={levers.closeRate} onChange={set('closeRate')} />
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Cost / booked call" prefix="$" value={levers.costPerBookedCall} onChange={set('costPerBookedCall')} />
                  <Num label="Cost / live call" prefix="$" value={levers.costPerLiveCall} onChange={set('costPerLiveCall')} />
                </div>
              </div>

              {/* Deal economics (lifetime commission model) */}
              <div className="tile tile-feedback p-5 space-y-4">
                <div className="eyebrow" style={{ fontSize: 10 }}>Deal economics · lifetime commission</div>
                <div className="grid grid-cols-2 gap-3">
                  <Num label="Avg deal value (first close)" prefix="$" value={levers.trialValue} onChange={set('trialValue')} />
                  <Num label="Avg monthly retainer" prefix="$" value={levers.monthlyValue} onChange={set('monthlyValue')} />
                  <Num label="Commission rate (close)" suffix="%" value={levers.commissionRate} onChange={set('commissionRate')} />
                  <Num label="Commission rate (ongoing)" suffix="%" value={levers.ascensionRate} onChange={set('ascensionRate')} />
                  <Num label="% of closes that ascend" suffix="%" value={levers.ascendRate} onChange={set('ascendRate')} />
                  <Num label="Avg client lifetime" suffix="mo" value={levers.lifetimeMonths} onChange={set('lifetimeMonths')} />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-text-400 mb-1.5">Pay model</div>
                    <div className="flex gap-1.5">
                      {['base', 'ramp'].map((pt) => (
                        <button key={pt} onClick={() => set('payType')(pt)}
                          className="px-3 py-1.5 rounded-sm text-[11px] font-semibold uppercase tracking-wider"
                          style={{
                            background: levers.payType === pt ? 'var(--accent)' : 'transparent',
                            color: 'var(--ink)',
                            border: '1px solid ' + (levers.payType === pt ? 'var(--ink)' : 'var(--rule)'),
                          }}>{pt}</button>
                      ))}
                    </div>
                  </div>
                  {levers.payType === 'ramp'
                    ? <Num label="Ramp / guarantee" prefix="$" value={levers.rampAmount} onChange={set('rampAmount')} />
                    : <Num label="Base salary / mo" prefix="$" value={levers.baseSalary} onChange={set('baseSalary')} />}
                </div>
                <div className="text-[11px] text-text-400 pt-1" style={{ borderTop: '1px solid var(--rule)' }}>
                  <span className="pt-3 inline-block">Lifetime commission per close:&nbsp;
                    <strong className="text-text-primary">{money(result?.perClose)}</strong></span>
                </div>
              </div>
            </div>

            {/* ── RIGHT: results ── */}
            <div className="space-y-5">
              {/* Headline: what it takes */}
              <div className="tile p-5" style={{ background: 'var(--accent-soft, rgba(240,224,80,0.06))', border: '1px solid var(--accent)' }}>
                <div className="eyebrow eyebrow-accent mb-1" style={{ fontSize: 10 }}>To make {money(target)}/mo you need</div>
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <Big label="Ad spend / mo" value={money(result?.adSpendNeeded)} accent />
                  <Big label="Booked calls / mo" value={whole(result?.bookedCallsNeeded)} />
                  <Big label="Live calls / mo" value={whole(result?.liveCallsNeeded)} />
                  <Big label="Closes / mo" value={whole(result?.closesNeeded)} />
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-4 text-[11px] text-text-400" style={{ borderTop: '1px solid var(--rule)', paddingTop: 12 }}>
                  <Row label="Commission needed" value={money(result?.commissionNeeded)} />
                  <Row label="Per close" value={money(result?.perClose)} />
                  <Row label="Gross revenue" value={money(result?.grossRevenue)} />
                  <Row label="Return on ad spend" value={result?.returnOnAdSpend ? `${result.returnOnAdSpend.toFixed(1)}×` : '—'} />
                  <Row label="Ad spend (by live call)" value={money(result?.adSpendByLive)} />
                </div>
              </div>

              {/* Where you're tracking now */}
              <div className="tile tile-feedback p-5">
                <div className="eyebrow mb-3" style={{ fontSize: 10 }}>At your current pace</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-bold" style={{ fontFamily: 'var(--serif)', color: result && result.gapToTarget <= 0 ? 'var(--up)' : 'var(--ink)' }}>
                    {money(result?.currentTakeHome)}
                  </span>
                  <span className="text-sm text-text-400">/ mo projected</span>
                </div>
                <div className="mt-1 text-sm" style={{ color: result && result.gapToTarget > 0 ? 'var(--down)' : 'var(--up)' }}>
                  {result && result.gapToTarget > 0
                    ? `${money(result.gapToTarget)} short of your goal`
                    : `On track — ${money(Math.abs(result?.gapToTarget))} above goal`}
                </div>
              </div>

              {/* What would need to change */}
              <div className="tile tile-feedback p-5">
                <div className="eyebrow mb-3" style={{ fontSize: 10 }}>To close the gap, any one of these</div>
                <ul className="space-y-2.5 text-sm">
                  <Lever
                    ok={result && Number.isFinite(result.extraLiveCalls) && result.extraLiveCalls <= 0}
                    text={result && result.extraLiveCalls > 0
                      ? <>Take <strong>{whole(result.extraLiveCalls)}</strong> more live calls / month (≈ <strong>{whole(result.extraBookedCalls)}</strong> more booked)</>
                      : <>Your current call volume already covers it</>} />
                  <Lever
                    ok={result && Number.isFinite(result.closeRateToHit) && parseFloat(stats.closeRate) >= result.closeRateToHit}
                    text={<>Lift your <strong>close rate</strong> to <strong>{pctStr(result?.closeRateToHit)}</strong> <span className="text-text-400">(now {stats.closeRate}%)</span> at today's call volume</>} />
                  <Lever
                    ok={result && Number.isFinite(result.showRateToHit) && parseFloat(stats.showRate) >= result.showRateToHit}
                    text={<>Lift your <strong>show rate</strong> to <strong>{pctStr(result?.showRateToHit)}</strong> <span className="text-text-400">(now {stats.showRate}%)</span> at today's bookings</>} />
                  <Lever
                    ok={false}
                    text={<>Put <strong>{money(result?.adSpendNeeded)}</strong>/mo into ads at <strong>{money(levers.costPerBookedCall)}</strong>/booked call</>} />
                </ul>
                <div className="mt-3 text-[11px] text-text-400">
                  Figures normalise the last {days}d to a month. Edit any lever on the left to see the funnel re-solve.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── small controls ────────────────────────────────────────────────────────
function Slider({ label, value, onChange, min = 0, max = 100, suffix = '' }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <span className="text-sm font-bold text-text-primary tabular-nums">{Number(value).toFixed(0)}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={1} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full" style={{ accentColor: 'var(--accent, #f0e050)' }} />
    </div>
  )
}

function Num({ label, value, onChange, prefix = '', suffix = '' }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-text-400">{label}</span>
      <div className="flex items-center mt-1 rounded-sm" style={{ background: 'var(--paper)', border: '1px solid var(--rule)' }}>
        {prefix && <span className="pl-2 text-text-400 text-sm">{prefix}</span>}
        <input type="number" value={value}
          onChange={(e) => onChange(e.target.value === '' ? 0 : parseFloat(e.target.value))}
          className="w-full px-2 py-1.5 text-sm font-semibold bg-transparent outline-none tabular-nums"
          style={{ color: 'var(--ink)' }} />
        {suffix && <span className="pr-2 text-text-400 text-sm">{suffix}</span>}
      </div>
    </label>
  )
}

function Big({ label, value, accent = false }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-400">{label}</div>
      <div className="text-2xl font-bold mt-0.5 tabular-nums"
        style={{ fontFamily: 'var(--serif)', color: accent ? 'var(--ink)' : 'var(--ink)' }}>{value}</div>
    </div>
  )
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <strong className="text-text-primary tabular-nums">{value}</strong>
    </div>
  )
}

function Lever({ text, ok }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 inline-block w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: ok ? 'var(--up)' : 'var(--accent, #f0e050)' }} />
      <span className="text-text-secondary">{text}</span>
    </li>
  )
}
