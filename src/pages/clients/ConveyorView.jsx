import { useEffect, useState } from 'react'
import { Check, Clock, CircleDashed, AlertCircle, Loader } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { materializeTouchpointsForClient, touchpointLabel } from '../../lib/touchpoints'

/*
  ConveyorView — lifecycle visualization for one client.
  Renders touchpoints grouped by stage (onboarding day 0-14, then steady_state).
*/

const STATUS_ICON = {
  scheduled:          <CircleDashed size={16} className="text-zinc-400" />,
  draft:              <Clock size={16} className="text-amber-500" />,
  queued_for_review:  <Clock size={16} className="text-amber-500" />,
  sent:               <Check size={16} className="text-emerald-700" />,
  acknowledged:       <Check size={16} className="text-emerald-700" />,
  completed:          <Check size={16} className="text-emerald-700" />,
  skipped:            <AlertCircle size={16} className="text-zinc-400" />,
  failed:             <AlertCircle size={16} className="text-rose-600" />,
}

export default function ConveyorView({ client }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [materializing, setMaterializing] = useState(false)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('client_touchpoints')
      .select('id, stage, cadence_day, touchpoint_key, channel, automated, status, scheduled_at, sent_at, assigned_to')
      .eq('client_id', client.id)
      .order('cadence_day', { ascending: true, nullsFirst: false })
      .order('scheduled_at', { ascending: true })
    if (err) setError(err.message)
    else setRows(data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [client.id])

  async function handleMaterialize() {
    setMaterializing(true)
    setError(null)
    try {
      const result = await materializeTouchpointsForClient(client, 'onboarding')
      await load()
      // success — silent reload
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setMaterializing(false)
    }
  }

  if (loading) return <div className="p-6"><Loader className="animate-spin text-zinc-400" /></div>

  if (rows.length === 0) {
    return (
      <div className="p-6">
        <div className="max-w-md bg-white border border-zinc-200 rounded-lg p-6">
          <h3 className="font-semibold text-zinc-900 mb-2">No touchpoints scheduled yet</h3>
          <p className="text-sm text-zinc-500 mb-4">
            Materialize the onboarding cadence to lay out all 40+ touchpoints across days 0-14.
            The dashboard will then schedule them automatically based on contract_start.
          </p>
          {!client.contract_start && (
            <p className="text-xs text-amber-700 mb-4">
              Heads up: this client has no contract_start date. Touchpoints will schedule from today.
            </p>
          )}
          {error && <p className="text-sm text-rose-700 mb-3">{error}</p>}
          <button
            onClick={handleMaterialize}
            disabled={materializing}
            className="px-4 py-2 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50"
          >
            {materializing ? 'Materializing...' : 'Materialize onboarding cadence'}
          </button>
        </div>
      </div>
    )
  }

  // group by stage
  const onboarding = rows.filter(r => r.stage === 'onboarding')
  const steady = rows.filter(r => r.stage === 'steady_state')
  const renewal = rows.filter(r => r.stage === 'renewal')

  return (
    <div className="p-6 space-y-8">
      {onboarding.length > 0 && (
        <StageBlock title="Onboarding (Day 0-14)" rows={onboarding} groupBy="cadence_day" />
      )}
      {steady.length > 0 && (
        <StageBlock title="Steady state" rows={steady} />
      )}
      {renewal.length > 0 && (
        <StageBlock title="Renewal countdown" rows={renewal} />
      )}
    </div>
  )
}

function StageBlock({ title, rows, groupBy }) {
  if (groupBy === 'cadence_day') {
    const grouped = rows.reduce((acc, r) => {
      const key = r.cadence_day ?? '?'
      acc[key] = acc[key] || []
      acc[key].push(r)
      return acc
    }, {})
    const days = Object.keys(grouped).sort((a, b) => Number(a) - Number(b))
    return (
      <section>
        <h3 className="font-semibold text-zinc-900 mb-3">{title}</h3>
        <div className="space-y-3">
          {days.map(day => (
            <div key={day} className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-zinc-50 border-b border-zinc-200 font-medium text-sm text-zinc-700">
                Day {day}
              </div>
              <ul className="divide-y divide-zinc-100">
                {grouped[day].map(r => <TouchpointRow key={r.id} row={r} />)}
              </ul>
            </div>
          ))}
        </div>
      </section>
    )
  }
  return (
    <section>
      <h3 className="font-semibold text-zinc-900 mb-3">{title}</h3>
      <div className="bg-white border border-zinc-200 rounded-lg overflow-hidden">
        <ul className="divide-y divide-zinc-100">
          {rows.map(r => <TouchpointRow key={r.id} row={r} />)}
        </ul>
      </div>
    </section>
  )
}

function TouchpointRow({ row }) {
  const icon = STATUS_ICON[row.status] ?? <CircleDashed size={16} className="text-zinc-400" />
  return (
    <li className="px-4 py-2.5 flex items-center gap-3 text-sm">
      <span className="flex-shrink-0">{icon}</span>
      <span className="flex-1 text-zinc-900">{touchpointLabel(row.touchpoint_key)}</span>
      <span className="text-xs text-zinc-500">
        {row.channel}
        {row.automated === false && ' · manual'}
      </span>
      <span className="text-xs text-zinc-400 w-32 text-right">
        {row.sent_at
          ? new Date(row.sent_at).toLocaleDateString()
          : row.scheduled_at
            ? `→ ${new Date(row.scheduled_at).toLocaleDateString()}`
            : ''}
      </span>
    </li>
  )
}
