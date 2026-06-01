import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'

const KIND_ICON = {
  new_lead: '☎',
  rank_jump: '↑',
  new_review_5star: '★',
  content_indexed: '✎',
  milestone: '◆',
  new_client_signed: '⌘',
  gbp_post_traction: '◉',
  citation_built: '⌁',
  backlink_earned: '⟁',
  serp_feature_won: '✦',
}

const KIND_LABEL = {
  new_lead: 'NEW LEAD',
  rank_jump: 'RANK JUMP',
  new_review_5star: '5★ REVIEW',
  content_indexed: 'INDEXED',
  milestone: 'MILESTONE',
  new_client_signed: 'NEW CLIENT',
  gbp_post_traction: 'GBP TRACTION',
  citation_built: 'CITATION',
  backlink_earned: 'BACKLINK',
  serp_feature_won: 'SERP FEATURE',
}

function timeAgo(iso) {
  const d = new Date(iso)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function HQWins() {
  const [wins, setWins] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterClient, setFilterClient] = useState('all')
  const [filterKind, setFilterKind] = useState('all')
  const [clients, setClients] = useState([])

  useEffect(() => {
    (async () => {
      const { data: c } = await supabase
        .from('clients')
        .select('id, business_name, slug')
        .order('business_name')
      setClients(c || [])

      const { data: w } = await supabase
        .from('wins')
        .select('id, kind, headline, detail, payload, source, created_at, slack_message_ts, client_id, clients(business_name, primary_city, vertical, slug)')
        .order('created_at', { ascending: false })
        .limit(200)
      setWins(w || [])
      setLoading(false)
    })()

    const channel = supabase
      .channel('wins-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'wins' }, async (payload) => {
        const { data: enriched } = await supabase
          .from('wins')
          .select('id, kind, headline, detail, payload, source, created_at, slack_message_ts, client_id, clients(business_name, primary_city, vertical, slug)')
          .eq('id', payload.new.id)
          .single()
        if (enriched) setWins((prev) => [enriched, ...prev].slice(0, 200))
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  const filtered = useMemo(() => {
    return wins.filter((w) => {
      if (filterClient !== 'all' && w.client_id !== filterClient) return false
      if (filterKind !== 'all' && w.kind !== filterKind) return false
      return true
    })
  }, [wins, filterClient, filterKind])

  const stats = useMemo(() => {
    const last7 = wins.filter((w) => new Date(w.created_at).getTime() > Date.now() - 7 * 86400e3)
    const byKind = {}
    last7.forEach((w) => { byKind[w.kind] = (byKind[w.kind] || 0) + 1 })
    return {
      total7: last7.length,
      leads: byKind.new_lead || 0,
      ranks: (byKind.rank_jump || 0) + (byKind.serp_feature_won || 0),
      reviews: byKind.new_review_5star || 0,
      content: byKind.content_indexed || 0,
      milestones: byKind.milestone || 0,
    }
  }, [wins])

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-display font-black uppercase tracking-tight" style={{ color: 'var(--rom-ink)' }}>
            Client Wins
          </h1>
          <div className="text-xs uppercase tracking-wider mt-1" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
            LIVE FEED · #client-wins · @channel
          </div>
        </div>
        <div className="flex gap-2">
          <select
            value={filterClient}
            onChange={(e) => setFilterClient(e.target.value)}
            className="text-xs px-3 py-2 border bg-bg-card"
            style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}
          >
            <option value="all">ALL CLIENTS</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.business_name.toUpperCase()}</option>
            ))}
          </select>
          <select
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value)}
            className="text-xs px-3 py-2 border bg-bg-card"
            style={{ fontFamily: 'JetBrains Mono, monospace', borderColor: 'var(--rom-rule)' }}
          >
            <option value="all">ALL KINDS</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatTile label="Total 7d" value={stats.total7} />
        <StatTile label="Leads" value={stats.leads} />
        <StatTile label="Rank jumps" value={stats.ranks} />
        <StatTile label="5★ reviews" value={stats.reviews} />
        <StatTile label="Content indexed" value={stats.content} />
        <StatTile label="Milestones" value={stats.milestones} />
      </div>

      <div className="rom-card">
        {loading && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>Loading wins…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="p-8 text-center text-sm" style={{ color: 'var(--rom-ink-2)' }}>
            No wins yet. They'll stream in here the moment the cron, webhook, or trigger fires.
          </div>
        )}
        {!loading && filtered.map((w) => <WinRow key={w.id} win={w} />)}
      </div>
    </div>
  )
}

function StatTile({ label, value }) {
  return (
    <div className="rom-kpi" style={{ padding: 14, background: 'var(--rom-paper)', border: '1px solid var(--rom-rule)' }}>
      <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
        {label}
      </div>
      <div className="text-3xl font-display font-black mt-1 tabular-nums" style={{ color: 'var(--rom-ink)' }}>
        {value}
      </div>
    </div>
  )
}

function WinRow({ win }) {
  const icon = KIND_ICON[win.kind] || '•'
  const label = KIND_LABEL[win.kind] || win.kind.toUpperCase()
  const clientName = win.clients?.business_name || 'Unknown'
  const clientCity = win.clients?.primary_city

  return (
    <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--rom-rule)' }}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 flex items-center justify-center text-xl flex-shrink-0" style={{ background: 'var(--rom-sage)', color: 'var(--rom-paper)' }}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="font-display font-black text-sm uppercase tracking-tight" style={{ color: 'var(--rom-ink)' }}>
              {win.headline}
            </span>
            <span className="text-xs uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--rom-sage)', fontFamily: 'JetBrains Mono, monospace' }}>
              {label}
            </span>
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--rom-ink-2)' }}>
            <span className="font-medium">{clientName}</span>
            {clientCity ? <span> · {clientCity}</span> : null}
            {win.source ? <span> · via {win.source}</span> : null}
          </div>
          {win.detail && (
            <div className="text-sm mt-2" style={{ color: 'var(--rom-ink)' }}
              dangerouslySetInnerHTML={{ __html: win.detail.replace(/\*([^*]+)\*/g, '<strong>$1</strong>') }} />
          )}
        </div>
        <div className="text-xs uppercase tracking-wider flex-shrink-0" style={{ color: 'var(--rom-ink-2)', fontFamily: 'JetBrains Mono, monospace' }}>
          {timeAgo(win.created_at)}
        </div>
      </div>
    </div>
  )
}
