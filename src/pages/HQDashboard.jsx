import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader, Building2, TrendingUp, DollarSign, Activity, Sparkles,
  ArrowRight, ArrowUpRight, Inbox, Calendar, Send, Check, AlertCircle, Plus, ClipboardList
} from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'

/*
  HQDashboard — the operational + portfolio home for the ROM team.

  Lands on / for every operator. Reads across:
    - clients               → portfolio counts, MRR, vertical mix
    - client_leads          → 7d / 30d lead flow
    - client_communications → unacknowledged inbox
    - client_touchpoints    → today's send queue + pending drafts
    - onboarding_sessions   → active wizard runs in progress

  Visual: ROM Sage Forest #1F4D3C primary on cream paper, mono receipts,
  serif italic on key numbers. Editorial, not corporate.
*/

const SAGE = '#1F4D3C'
const SAGE_LIGHT = '#E8EFEB'
const PAPER = '#FBFAF6'

export default function HQDashboard() {
  const { profile } = useAuth()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function load() {
      const since7 = new Date(); since7.setDate(since7.getDate() - 7)
      const since30 = new Date(); since30.setDate(since30.getDate() - 30)
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(); dayEnd.setHours(23, 59, 59, 999)

      try {
        const [clients, leads30, leads7, unackedComms, todayTouchpoints, queuedDrafts, activeSessions, recentActivity] = await Promise.all([
          supabase.from('clients').select('id, slug, business_name, status, vertical, monthly_fee, primary_city, state_abbr, created_at, primary_am'),
          supabase.from('client_leads').select('id, converted, deal_value, source, created_at').gte('created_at', since30.toISOString()),
          supabase.from('client_leads').select('id', { count: 'exact', head: true }).gte('created_at', since7.toISOString()),
          supabase.from('client_communications').select('id, client_id, body, sentiment, channel, created_at').is('acknowledged_at', null).eq('direction', 'inbound').order('created_at', { ascending: false }).limit(8),
          supabase.from('client_touchpoints').select('id, client_id, touchpoint_key, channel, scheduled_at, status').lte('scheduled_at', dayEnd.toISOString()).gte('scheduled_at', dayStart.toISOString()).eq('status', 'scheduled').limit(20),
          supabase.from('client_touchpoints').select('id, client_id, touchpoint_key, channel, template_key').in('status', ['queued_for_review','draft']).limit(10),
          supabase.from('onboarding_sessions').select('id, business_name_draft, vertical_draft, status, started_at, last_active_at').not('status', 'in', '("launched","aborted")').order('last_active_at', { ascending: false }).limit(5),
          supabase.from('onboarding_audit_log').select('actor, action, target_kind, created_at').order('created_at', { ascending: false }).limit(8),
        ])
        if (!mounted) return

        const cl = clients.data || []
        const active = cl.filter(c => ['active','trial','onboarding'].includes(c.status))
        const mrr = active.reduce((s, c) => s + Number(c.monthly_fee || 0), 0)
        const monthlyRev = (leads30.data || []).filter(l => l.converted && l.deal_value).reduce((s, l) => s + Number(l.deal_value), 0)
        const verticalCount = active.reduce((acc, c) => { acc[c.vertical] = (acc[c.vertical] || 0) + 1; return acc }, {})

        setData({
          activeClients: active.length,
          totalClients: cl.length,
          newClients30d: cl.filter(c => new Date(c.created_at) > since30).length,
          mrr,
          arr: mrr * 12,
          monthlyAttributableRev: monthlyRev,
          leads7d: leads7.count || 0,
          leads30d: (leads30.data || []).length,
          conversions30d: (leads30.data || []).filter(l => l.converted).length,
          unackedComms: unackedComms.data || [],
          unackedTotal: unackedComms.data?.length || 0,
          todayTouchpoints: todayTouchpoints.data || [],
          queuedDrafts: queuedDrafts.data || [],
          activeSessions: activeSessions.data || [],
          recentActivity: recentActivity.data || [],
          verticalCount,
          clientsByLookup: Object.fromEntries(cl.map(c => [c.id, c])),
        })
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [])

  if (loading) return <div className="p-10 flex justify-center"><Loader className="animate-spin" style={{ color: SAGE }} /></div>
  if (!data) return null

  const firstName = (profile?.full_name || profile?.email || 'there').split(' ')[0].split('@')[0]
  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Up late' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : hour < 22 ? 'Evening' : 'Late tonight'
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* ─── Masthead ────────────────────────────────────────────── */}
      <div className="flex items-end justify-between mb-7 pb-5 border-b" style={{ borderColor: 'var(--rule)' }}>
        <div>
          <span className="eyebrow" style={{ color: SAGE, fontWeight: 600 }}>
            Rank On Maps · HQ
          </span>
          <h1 className="mt-2" style={{ fontFamily: 'var(--serif)', fontSize: 40, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
            {greeting}, <em style={{ fontStyle: 'italic' }}>{firstName}.</em>
          </h1>
          <p className="text-xs mt-2" style={{ fontFamily: 'var(--mono)', letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {today}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/clients/new" className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white" style={{ background: SAGE }}>
            <Plus size={14} /> New client
          </Link>
        </div>
      </div>

      {/* ─── KPI strip ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KPI label="Active clients" value={data.activeClients} sub={`+${data.newClients30d} this month`} accent />
        <KPI label="MRR" value={`$${data.mrr.toLocaleString()}`} sub={`ARR $${data.arr.toLocaleString()}`} />
        <KPI label="Client revenue (30d)" value={`$${data.monthlyAttributableRev.toLocaleString()}`} sub={`${data.conversions30d} conversions`} />
        <KPI label="Leads (7d)" value={data.leads7d} sub={`${data.leads30d} in 30d`} />
      </div>

      {/* ─── Two-column body ─────────────────────────────────────── */}
      <div className="grid grid-cols-12 gap-6">
        {/* Left: actionable queues */}
        <div className="col-span-12 lg:col-span-8 space-y-5">

          {/* Today's send queue */}
          <Card title="Today's send queue" icon={Send} count={data.todayTouchpoints.length}>
            {data.todayTouchpoints.length === 0
              ? <Empty>Nothing scheduled to send today. Either nothing's onboarding, or your touchpoint cadence is empty for this date.</Empty>
              : <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {data.todayTouchpoints.slice(0, 8).map(t => {
                    const c = data.clientsByLookup[t.client_id]
                    return (
                      <li key={t.id} className="py-2.5 flex items-center justify-between text-sm">
                        <div className="flex-1 min-w-0">
                          <Link to={c ? `/clients/${c.slug}/touchpoints` : '#'} className="font-medium hover:underline" style={{ color: 'var(--ink)' }}>
                            {touchpointLabel(t.touchpoint_key)}
                          </Link>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>
                            {c?.business_name || 'unknown client'} · {t.channel}
                          </div>
                        </div>
                        <span className="text-xs" style={{ fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>
                          {new Date(t.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </li>
                    )
                  })}
                </ul>}
          </Card>

          {/* Drafts awaiting review */}
          <Card title="Drafts awaiting your review" icon={ClipboardList} count={data.queuedDrafts.length} accent="amber">
            {data.queuedDrafts.length === 0
              ? <Empty>No drafts queued. Touchpoints auto-fill here when the platform generates a message for you to approve.</Empty>
              : <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {data.queuedDrafts.map(t => {
                    const c = data.clientsByLookup[t.client_id]
                    return (
                      <li key={t.id} className="py-2.5 flex items-center justify-between text-sm">
                        <div className="flex-1">
                          <div className="font-medium" style={{ color: 'var(--ink)' }}>{touchpointLabel(t.touchpoint_key)}</div>
                          <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>{c?.business_name} · {t.template_key || t.channel}</div>
                        </div>
                        <Link to={c ? `/clients/${c.slug}/touchpoints` : '#'} className="text-xs px-2 py-1 rounded font-medium text-white" style={{ background: SAGE }}>
                          Review
                        </Link>
                      </li>
                    )
                  })}
                </ul>}
          </Card>

          {/* Active onboarding sessions */}
          <Card title="Active onboardings" icon={Sparkles} count={data.activeSessions.length}>
            {data.activeSessions.length === 0
              ? <Empty>No active wizard sessions. Start one from <Link to="/clients/new" className="underline" style={{ color: SAGE }}>/clients/new</Link>.</Empty>
              : <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {data.activeSessions.map(s => (
                    <li key={s.id} className="py-2.5 flex items-center justify-between text-sm">
                      <div className="flex-1">
                        <Link to={`/clients/new/${s.id}`} className="font-medium hover:underline" style={{ color: 'var(--ink)' }}>
                          {s.business_name_draft || 'Untitled client'}
                        </Link>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--ink-3)' }}>
                          {s.vertical_draft} · last active {timeAgo(s.last_active_at)}
                        </div>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full capitalize" style={{ background: SAGE_LIGHT, color: SAGE }}>
                        {s.status}
                      </span>
                    </li>
                  ))}
                </ul>}
          </Card>
        </div>

        {/* Right: inbox + activity + vertical mix */}
        <div className="col-span-12 lg:col-span-4 space-y-5">

          {/* Inbox — unacknowledged client messages */}
          <Card title="Inbox" icon={Inbox} count={data.unackedTotal} accent={data.unackedTotal > 0 ? 'amber' : null}>
            {data.unackedTotal === 0
              ? <Empty>No unacknowledged client messages. Inbox zero.</Empty>
              : <ul className="divide-y" style={{ borderColor: 'var(--rule)' }}>
                  {data.unackedComms.slice(0, 6).map(m => {
                    const c = data.clientsByLookup[m.client_id]
                    return (
                      <li key={m.id} className="py-2 text-sm">
                        <Link to={c ? `/clients/${c.slug}/comms` : '#'} className="font-medium hover:underline" style={{ color: 'var(--ink)' }}>
                          {c?.business_name || 'unknown'}
                        </Link>
                        <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--ink-3)' }}>{m.body || '(empty)'}</div>
                        <div className="text-xs mt-0.5" style={{ fontFamily: 'var(--mono)', color: 'var(--ink-4)' }}>
                          {m.channel} · {timeAgo(m.created_at)}
                        </div>
                      </li>
                    )
                  })}
                </ul>}
          </Card>

          {/* Vertical mix */}
          <Card title="Portfolio mix" icon={Building2}>
            {Object.keys(data.verticalCount).length === 0
              ? <Empty>No active clients yet.</Empty>
              : <ul className="space-y-2 text-sm">
                  {Object.entries(data.verticalCount).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                    <li key={v} className="flex items-center justify-between">
                      <span className="capitalize" style={{ color: 'var(--ink)' }}>{v}</span>
                      <div className="flex items-center gap-2">
                        <div style={{ width: 60, height: 4, background: 'var(--rule)', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${(n / data.activeClients) * 100}%`, height: '100%', background: SAGE }} />
                        </div>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>{n}</span>
                      </div>
                    </li>
                  ))}
                </ul>}
          </Card>

          {/* Recent platform activity */}
          <Card title="Recent activity" icon={Activity}>
            {data.recentActivity.length === 0
              ? <Empty>No recent platform activity yet.</Empty>
              : <ul className="space-y-2 text-xs">
                  {data.recentActivity.slice(0, 6).map((a, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span style={{ color: SAGE, marginTop: 3 }}>•</span>
                      <div className="flex-1">
                        <div style={{ color: 'var(--ink)' }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: SAGE, marginRight: 6 }}>
                            {a.actor.slice(0, 12)}
                          </span>
                          {a.action.replace(/_/g, ' ')} {a.target_kind?.replace(/_/g, ' ')}
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)' }}>{timeAgo(a.created_at)}</div>
                      </div>
                    </li>
                  ))}
                </ul>}
          </Card>
        </div>
      </div>
    </div>
  )
}

// ─── primitives ─────────────────────────────────────────────────
function KPI({ label, value, sub, accent }) {
  return (
    <div className="bg-white rounded-md p-4" style={{ border: `1px solid ${accent ? SAGE_LIGHT : 'var(--rule)'}`, background: accent ? SAGE_LIGHT : '#fff' }}>
      <div className="eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div className="mt-1.5" style={{ fontFamily: 'var(--serif)', fontSize: 30, lineHeight: 1, color: SAGE, letterSpacing: '-0.02em' }}>
        {value}
      </div>
      {sub && <div className="mt-1.5 text-xs" style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)' }}>{sub}</div>}
    </div>
  )
}

function Card({ title, icon: Icon, count, accent, children }) {
  const accentColor = accent === 'amber' ? '#92400e' : SAGE
  const accentBg = accent === 'amber' ? '#fef3c7' : SAGE_LIGHT
  return (
    <div className="bg-white rounded-md" style={{ border: '1px solid var(--rule)' }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div className="flex items-center gap-2">
          {Icon && <Icon size={14} style={{ color: accentColor }} />}
          <h3 className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>{title}</h3>
        </div>
        {count != null && count > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: accentBg, color: accentColor }}>
            {count}
          </span>
        )}
      </div>
      <div className="px-4 py-3">{children}</div>
    </div>
  )
}

function Empty({ children }) {
  return <p className="text-xs py-2" style={{ color: 'var(--ink-3)' }}>{children}</p>
}

function touchpointLabel(key) {
  if (!key) return 'Untitled'
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/Am\b/g, 'AM')
    .replace(/Sms\b/g, 'SMS')
    .replace(/Gbp\b/g, 'GBP')
}

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
