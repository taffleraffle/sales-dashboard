import { useEffect, useState } from 'react'
import { Loader, Send, X, Edit3, Check } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { touchpointLabel } from '../../lib/touchpoints'

/*
  TouchpointsQueue — the AM's "draft → review → send" surface.

  Three columns:
    Queued for review   touchpoints the platform generated, awaiting AM
    Scheduled (upcoming) touchpoints not yet fired
    Recently sent       last 7 days of touchpoints fired
*/

export default function TouchpointsQueue({ client }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState({})

  async function load() {
    setLoading(true)
    const since = new Date()
    since.setDate(since.getDate() - 7)
    const { data, error } = await supabase
      .from('client_touchpoints')
      .select('id, stage, cadence_day, touchpoint_key, channel, automated, status, scheduled_at, sent_at, payload, template_key')
      .eq('client_id', client.id)
      .or(`status.eq.queued_for_review,status.eq.draft,status.eq.scheduled,and(status.in.(sent,acknowledged,completed),sent_at.gte.${since.toISOString()})`)
      .order('scheduled_at', { ascending: true })
    if (!error) setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [client.id])

  async function updateStatus(id, status, extra = {}) {
    setActing(s => ({ ...s, [id]: true }))
    try {
      const { error } = await supabase
        .from('client_touchpoints')
        .update({ status, sent_at: status === 'sent' ? new Date().toISOString() : null, ...extra })
        .eq('id', id)
      if (error) throw error
      await load()
    } catch (e) {
      alert('Update failed: ' + e.message)
    } finally {
      setActing(s => ({ ...s, [id]: false }))
    }
  }

  if (loading) return <div className="p-6"><Loader className="animate-spin text-zinc-400" /></div>

  const queued = rows.filter(r => r.status === 'queued_for_review' || r.status === 'draft')
  const scheduled = rows.filter(r => r.status === 'scheduled')
  const sent = rows.filter(r => r.status === 'sent' || r.status === 'acknowledged' || r.status === 'completed')

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Column title={`Queued for review (${queued.length})`} accent="amber">
        {queued.length === 0 && <Empty>No drafts awaiting review.</Empty>}
        {queued.map(r => (
          <DraftCard
            key={r.id}
            row={r}
            acting={acting[r.id]}
            onSend={() => updateStatus(r.id, 'sent')}
            onSkip={() => updateStatus(r.id, 'skipped')}
          />
        ))}
      </Column>

      <Column title={`Scheduled (${scheduled.length})`} accent="zinc">
        {scheduled.length === 0 && <Empty>No upcoming touchpoints.</Empty>}
        {scheduled.map(r => <ScheduledCard key={r.id} row={r} />)}
      </Column>

      <Column title={`Sent (last 7 days · ${sent.length})`} accent="emerald">
        {sent.length === 0 && <Empty>Nothing sent recently.</Empty>}
        {sent.map(r => <SentCard key={r.id} row={r} />)}
      </Column>
    </div>
  )
}

function Column({ title, children, accent }) {
  const accentClass = {
    amber: 'border-t-amber-500',
    zinc: 'border-t-zinc-400',
    emerald: 'border-t-emerald-700',
  }[accent] || 'border-t-zinc-300'
  return (
    <div className={`bg-white border border-zinc-200 border-t-2 ${accentClass} rounded-lg p-3 space-y-2 min-h-[300px]`}>
      <h3 className="font-semibold text-zinc-900 text-sm mb-2 px-1">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Empty({ children }) {
  return <p className="px-2 py-4 text-xs text-zinc-400 text-center">{children}</p>
}

function DraftCard({ row, acting, onSend, onSkip }) {
  return (
    <div className="border border-zinc-200 rounded-md p-3 bg-amber-50/40">
      <div className="font-medium text-sm text-zinc-900">{touchpointLabel(row.touchpoint_key)}</div>
      <div className="text-xs text-zinc-500 mt-0.5">{row.channel} · {row.template_key || 'no template'}</div>
      {row.payload?.notes && <p className="text-xs text-zinc-600 mt-2 italic">{row.payload.notes}</p>}
      <div className="mt-3 flex gap-2">
        <button
          disabled={acting}
          onClick={onSend}
          className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-700 text-white rounded text-xs font-medium hover:bg-emerald-800 disabled:opacity-50"
        >
          <Send size={12} /> Send as me
        </button>
        <button
          disabled={acting}
          onClick={onSkip}
          className="px-2 py-1.5 border border-zinc-200 rounded text-xs text-zinc-600 hover:bg-zinc-50"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}

function ScheduledCard({ row }) {
  return (
    <div className="border border-zinc-200 rounded-md p-3">
      <div className="font-medium text-sm text-zinc-900">{touchpointLabel(row.touchpoint_key)}</div>
      <div className="text-xs text-zinc-500 mt-0.5">
        {row.channel}
        {row.automated === false && ' · manual'}
        {row.scheduled_at && ` · → ${new Date(row.scheduled_at).toLocaleDateString()}`}
      </div>
    </div>
  )
}

function SentCard({ row }) {
  return (
    <div className="border border-zinc-200 rounded-md p-3 opacity-80">
      <div className="font-medium text-sm text-zinc-900 flex items-center gap-1">
        <Check size={12} className="text-emerald-700" />
        {touchpointLabel(row.touchpoint_key)}
      </div>
      <div className="text-xs text-zinc-500 mt-0.5">
        {row.channel}
        {row.sent_at && ` · ${new Date(row.sent_at).toLocaleDateString()}`}
      </div>
    </div>
  )
}
