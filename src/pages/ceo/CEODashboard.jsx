import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Loader, TrendingUp, Users, DollarSign, Activity, Target, Building2, ArrowRight } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  CEODashboard — single-pane founder view.

  Aggregates across all client and operational data:
    - Active clients (count + new this month + churn)
    - Total agency-attributable revenue (sum of client_leads.deal_value where converted)
    - Pipeline value (open opportunities in GHL)
    - Lead flow (last 7 days across all clients)
    - Map Pack performance (avg position across all clients)
    - Operator load (clients per AM + queue depth)
    - "Needs attention" flags across portfolio

  V1: the data sources are pulled directly from the existing tables we've already
  built. Sales-team data (closer_eod_reports, marketing_tracker, payments, etc.)
  is read from the OPT-era tables that remain in this Supabase project.

  V2: add agency_metrics_monthly aggregates + sellability metrics (avg time-to-top-3
  by vertical, lifetime ROI per dollar of fee, etc.).
*/

export default function CEODashboard() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      const since30 = new Date(); since30.setDate(since30.getDate() - 30)
      const since7 = new Date(); since7.setDate(since7.getDate() - 7)

      try {
        const [clientsRes, leadsRes, leads7Res, attentionRes] = await Promise.all([
          supabase.from('clients').select('id, status, vertical, monthly_fee, created_at'),
          supabase.from('client_leads')
            .select('id, converted, deal_value, created_at')
            .gte('created_at', since30.toISOString()),
          supabase.from('client_leads')
            .select('id, source', { count: 'exact', head: true })
            .gte('created_at', since7.toISOString()),
          supabase.from('client_communications')
            .select('id', { count: 'exact', head: true })
            .is('acknowledged_at', null)
            .eq('direction', 'inbound'),
        ])

        if (!mounted) return

        const clients = clientsRes.data || []
        const leads30 = leadsRes.data || []
        const activeClients = clients.filter(c => ['active','trial','onboarding'].includes(c.status))
        const mrr = activeClients.reduce((sum, c) => sum + Number(c.monthly_fee || 0), 0)
        const arr = mrr * 12
        const monthlyRev = leads30.filter(l => l.converted && l.deal_value).reduce((s, l) => s + Number(l.deal_value), 0)
        const newClientsThisMonth = clients.filter(c => new Date(c.created_at) > since30).length

        const verticalBreakdown = activeClients.reduce((acc, c) => {
          acc[c.vertical] = (acc[c.vertical] || 0) + 1
          return acc
        }, {})

        setStats({
          activeClients: activeClients.length,
          newClientsThisMonth,
          churned: clients.filter(c => c.status === 'churned').length,
          mrr, arr,
          monthlyAttributableRev: monthlyRev,
          leads7d: leads7Res.count || 0,
          leads30d: leads30.length,
          conversions30d: leads30.filter(l => l.converted).length,
          unackedComms: attentionRes.count || 0,
          verticalBreakdown,
        })
      } finally {
        if (mounted) setLoading(false)
      }
    }
    load()
    return () => { mounted = false }
  }, [])

  if (loading) return <div className="p-10 flex justify-center"><Loader className="animate-spin text-zinc-400" /></div>
  if (!stats) return <div className="p-6 text-sm text-zinc-500">No data yet.</div>

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900">CEO Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Portfolio view across every active client.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <BigStat label="MRR" value={`$${stats.mrr.toLocaleString()}`} sub={`ARR $${stats.arr.toLocaleString()}`} icon={DollarSign} />
        <BigStat label="Active clients" value={stats.activeClients} sub={`+${stats.newClientsThisMonth} this month · ${stats.churned} churned`} icon={Building2} />
        <BigStat label="Client revenue (30d)" value={`$${stats.monthlyAttributableRev.toLocaleString()}`} sub="from converted leads" icon={TrendingUp} />
        <BigStat label="Leads (7d)" value={stats.leads7d} sub={`${stats.conversions30d} conversions/30d`} icon={Activity} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Panel title="Vertical breakdown" icon={Target}>
          {Object.keys(stats.verticalBreakdown).length === 0
            ? <p className="text-sm text-zinc-400">No active clients yet.</p>
            : <ul className="space-y-2 text-sm">
                {Object.entries(stats.verticalBreakdown).sort((a,b) => b[1] - a[1]).map(([v, n]) => (
                  <li key={v} className="flex items-center justify-between">
                    <span className="capitalize text-zinc-700">{v}</span>
                    <span className="font-mono text-zinc-900">{n}</span>
                  </li>
                ))}
              </ul>
          }
        </Panel>

        <Panel title="Needs attention" icon={Activity} accent="amber">
          <ul className="space-y-2 text-sm">
            {stats.unackedComms > 0 && (
              <li className="flex items-center justify-between text-amber-700">
                <span>Unacknowledged client messages</span>
                <span className="font-mono">{stats.unackedComms}</span>
              </li>
            )}
            {stats.unackedComms === 0 && <p className="text-sm text-zinc-400">No flags right now.</p>}
          </ul>
          <Link to="/clients" className="mt-3 text-xs text-emerald-700 hover:underline inline-flex items-center gap-1">Open clients <ArrowRight size={12} /></Link>
        </Panel>

        <Panel title="Data sources" icon={Users}>
          <ul className="space-y-1 text-xs text-zinc-600">
            <li>↳ <Link to="/sales" className="hover:text-emerald-700">Sales overview</Link></li>
            <li>↳ <Link to="/sales/closers" className="hover:text-emerald-700">Closers</Link></li>
            <li>↳ <Link to="/sales/setters" className="hover:text-emerald-700">Setters</Link></li>
            <li>↳ <Link to="/sales/marketing" className="hover:text-emerald-700">Marketing performance</Link></li>
            <li>↳ <Link to="/sales/contracts" className="hover:text-emerald-700">Contracts</Link></li>
            <li>↳ <Link to="/sales/commissions" className="hover:text-emerald-700">Commissions</Link></li>
            <li>↳ <Link to="/clients" className="hover:text-emerald-700">Clients</Link></li>
          </ul>
        </Panel>
      </div>

      <div className="mt-6 p-4 bg-white border border-zinc-200 rounded-lg">
        <h3 className="font-semibold text-zinc-900 mb-2 text-sm">What's coming next on this dashboard</h3>
        <ul className="text-xs text-zinc-600 space-y-1">
          <li>• Sellability metrics — avg time-to-top-3 by vertical, lifetime ROI per fee dollar</li>
          <li>• Operator load — clients per AM, queue depth, SLA breaches</li>
          <li>• Cash flow + Stripe MRR live feed</li>
          <li>• Churn risk early-warning (no contact &gt;14d, sentiment drop, ranking regression)</li>
          <li>• White-label / multi-tenant agency metrics when other agencies onboard</li>
        </ul>
      </div>
    </div>
  )
}

function BigStat({ label, value, sub, icon: Icon }) {
  return (
    <div className="bg-white border border-zinc-200 rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
        {Icon && <Icon size={16} className="text-zinc-400" />}
      </div>
      <div className="text-2xl font-semibold text-zinc-900">{value}</div>
      {sub && <div className="text-xs text-zinc-500 mt-1">{sub}</div>}
    </div>
  )
}

function Panel({ title, icon: Icon, children, accent }) {
  const accentClass = accent === 'amber' ? 'border-amber-200' : 'border-zinc-200'
  return (
    <div className={`bg-white border ${accentClass} rounded-lg p-4`}>
      <div className="flex items-center gap-2 mb-3">
        {Icon && <Icon size={16} className="text-zinc-500" />}
        <h3 className="font-semibold text-zinc-900 text-sm">{title}</h3>
      </div>
      {children}
    </div>
  )
}
