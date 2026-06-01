import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { ink, ink2, ink3, hair, accent } from '../ui'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Banner that appears at the top of a call row when AI suggestions exist.
// Props:
//   call: { id, ai_prefill_payload, ai_prefill_status, ghl_event_id }
//   onApply(suggestions): merge AI suggestions into the parent's mark state
//   onRefresh(): callback after re-pull completes
export default function AIPrefillBanner({ call, onApply, onRefresh }) {
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  const status = call?.ai_prefill_status || 'none'
  const payload = call?.ai_prefill_payload

  async function runPrefill() {
    if (!call?.id) return
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-prefill-call-outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ closer_call_id: call.id }),
      })
      const j = await res.json()
      if (j.status === 'ok' && j.suggestions) {
        if (onApply) onApply(j.suggestions)
        if (onRefresh) onRefresh()
      } else if (j.status === 'no_transcript') {
        setErr('No Fathom transcript yet — try again after Fathom syncs (within 15 min of call end).')
      } else if (j.status === 'already_confirmed') {
        setErr('This row has already been confirmed — refresh to re-pull.')
      } else {
        setErr(j.error || 'Unknown error')
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  const tone = status === 'confirmed' ? '#1f7a4d' : status === 'overridden' ? '#a16d00' : accent
  const label = status === 'confirmed' ? '✓ AI suggestions confirmed'
              : status === 'overridden' ? '⚠ AI suggestions overridden'
              : status === 'pending_review' ? '🤖 AI suggestions ready for review'
              : 'No AI suggestions yet'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px', background: 'rgba(31,77,60,0.04)',
      border: `1px solid ${tone}33`, borderRadius: 6, marginBottom: 8,
      fontSize: 12, color: ink2, letterSpacing: '-0.005em',
    }}>
      <div>
        <span style={{ color: tone, fontWeight: 500 }}>{label}</span>
        {payload?.notes && status === 'pending_review' && (
          <span style={{ marginLeft: 10, color: ink3, fontSize: 11 }}>· {String(payload.notes).slice(0, 80)}</span>
        )}
        {err && <span style={{ marginLeft: 10, color: 'var(--color-neg)', fontSize: 11 }}>{err}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {payload && (
          <button
            type="button"
            onClick={() => onApply && onApply(payload)}
            style={btnStyle}
          >
            Apply
          </button>
        )}
        <button
          type="button"
          onClick={runPrefill}
          disabled={loading}
          style={{ ...btnStyle, opacity: loading ? 0.5 : 1, cursor: loading ? 'wait' : 'pointer' }}
        >
          {loading ? 'Analyzing…' : payload ? 'Re-pull' : 'Pull AI suggestions'}
        </button>
      </div>
    </div>
  )
}

const btnStyle = {
  padding: '4px 10px', fontSize: 11, fontFamily: 'inherit',
  border: hair, borderRadius: 4, background: 'var(--color-bg-alt)', color: ink, cursor: 'pointer',
}

// Helper: merge AI suggestions into mark state shape used by GranularOutcomeFields.
// Maps AI's snake_case "no-close"/"follow-up" outcome to our enum keys.
export function applySuggestionsToMark(currentMark, suggestions) {
  const next = { ...currentMark }
  const map = {
    'closed': 'closed',
    'follow-up': 'follow_up_booked',
    'no-close': 'not_closed',
  }
  if (suggestions.outcome && map[suggestions.outcome]) next.outcome = map[suggestions.outcome]
  if (suggestions.confirmed_method) next.confirm_method = suggestions.confirmed_method
  if (suggestions.decision_maker_present != null) next.decision_maker_present = suggestions.decision_maker_present
  if (Array.isArray(suggestions.offers_pitched)) next.offers_pitched = suggestions.offers_pitched
  if (suggestions.offer_downsell_occurred != null) next.offer_downsell_occurred = suggestions.offer_downsell_occurred
  if (suggestions.follow_up_reason) next.follow_up_reason = suggestions.follow_up_reason
  if (suggestions.follow_up_timeframe_days != null) next.follow_up_timeframe_days = suggestions.follow_up_timeframe_days
  if (suggestions.follow_up_timeframe_reason) next.follow_up_timeframe_reason = suggestions.follow_up_timeframe_reason
  if (suggestions.objection_category) next.objection_category = suggestions.objection_category
  if (suggestions.next_state) next.next_state = suggestions.next_state
  if (suggestions.pre_call_video_watched_pct != null) next.pre_call_video_watched_pct = suggestions.pre_call_video_watched_pct
  return next
}
