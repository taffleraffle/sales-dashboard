import { ink, ink2, ink3, hair, accent, neg } from '../ui'

// Granular call-tracking fields. Used by both the regular EOD page and Quick Backfill.
// Each row's state is owned by the caller — this is a controlled component.
//
// Props:
//   value: { confirm_method, decision_maker_present, offers_pitched, offer_downsell_occurred,
//            follow_up_reason, follow_up_timeframe_days, follow_up_timeframe_reason,
//            objection_category, next_state, pre_call_video_watched_pct }
//   onChange(field, value)
//   outcome: current outcome (drives conditional reveals)

const CONFIRM_METHODS = [
  { v: 'call',        l: 'Call' },
  { v: 'auto-text',   l: 'Auto-text' },
  { v: 'unconfirmed', l: 'Unconfirmed' },
  { v: 'none',        l: 'None' },
]

const OFFERS = [
  { v: 'full-stack',       l: 'Full-stack' },
  { v: 'maps-only',        l: 'Maps-only' },
  { v: 'trial',            l: 'Trial' },
  { v: 'ascension-upsell', l: 'Ascension' },
]

const FOLLOW_UP_REASONS = [
  { v: 'logistics',         l: 'Logistics' },
  { v: 'think-about-it',    l: 'Think about it' },
  { v: 'partner',           l: 'Partner / spouse / team' },
  { v: 'proof/uncertainty', l: 'Proof / uncertainty' },
]

const OBJECTIONS = [
  { v: 'price',                   l: 'Price' },
  { v: 'trust',                   l: 'Trust' },
  { v: 'timing',                  l: 'Timing' },
  { v: 'fit',                     l: 'Fit' },
  { v: 'decision-maker-missing',  l: 'DM missing' },
]

const NEXT_STATES = [
  { v: 'follow-up',          l: 'Follow-up' },
  { v: 'long-term-nurture',  l: 'Long-term nurture' },
  { v: 'dead',               l: 'Dead' },
]

function Pills({ options, value, onChange, multi = false }) {
  const active = multi ? (Array.isArray(value) ? value : []) : (value || '')
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(o => {
        const isOn = multi ? active.includes(o.v) : active === o.v
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => {
              if (multi) {
                const next = isOn ? active.filter(x => x !== o.v) : [...active, o.v]
                onChange(next)
              } else {
                onChange(isOn ? null : o.v)
              }
            }}
            style={{
              padding: '5px 10px', fontSize: 11, fontFamily: 'inherit', borderRadius: 4,
              border: hair, cursor: 'pointer',
              background: isOn ? accent : 'var(--color-bg-alt)',
              color: isOn ? '#FAF8F2' : ink2,
            }}
          >
            {o.l}
          </button>
        )
      })}
    </div>
  )
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'start', marginTop: 8 }}>
      <div>
        <div style={{ fontSize: 11, color: ink2, lineHeight: 1.3 }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: ink3, marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  )
}

export default function GranularOutcomeFields({ value = {}, onChange, outcome }) {
  const set = (field) => (v) => onChange(field, v)

  const isLive = ['closed', 'follow_up_booked', 'not_closed'].includes(outcome)
  const isFollowUp = outcome === 'follow_up_booked'
  const isNoClose = outcome === 'not_closed'

  const offersPitched = value.offers_pitched || []
  const downsellSuggested = offersPitched.includes('full-stack') && offersPitched.includes('maps-only')

  return (
    <div style={{ borderTop: hair, marginTop: 10, paddingTop: 10 }}>
      <FieldRow label="Confirm method" hint="Call confirm = real convo. Auto-text = passive.">
        <Pills options={CONFIRM_METHODS} value={value.confirm_method} onChange={set('confirm_method')} />
      </FieldRow>

      <FieldRow label="Pre-call video watch %" hint="0–100. From Loom view %.">
        <input
          type="number" min="0" max="100"
          value={value.pre_call_video_watched_pct ?? ''}
          onChange={e => set('pre_call_video_watched_pct')(e.target.value === '' ? null : Number(e.target.value))}
          style={{ width: 80, padding: '4px 6px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit' }}
        />
      </FieldRow>

      {isLive && (
        <>
          <FieldRow label="Decision-maker present" hint="">
            <Pills
              options={[{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }]}
              value={value.decision_maker_present === true ? 'yes' : value.decision_maker_present === false ? 'no' : ''}
              onChange={v => set('decision_maker_present')(v === 'yes' ? true : v === 'no' ? false : null)}
            />
          </FieldRow>

          <FieldRow label="Offers pitched" hint="Multi — tick all that applied.">
            <Pills options={OFFERS} value={offersPitched} onChange={set('offers_pitched')} multi />
            {downsellSuggested && (
              <label style={{ fontSize: 11, color: ink2, marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!value.offer_downsell_occurred}
                  onChange={e => set('offer_downsell_occurred')(e.target.checked)}
                />
                Downsell mid-call
              </label>
            )}
          </FieldRow>
        </>
      )}

      {isFollowUp && (
        <>
          <FieldRow label="Follow-up reason" hint="Why are we rebooking?">
            <Pills options={FOLLOW_UP_REASONS} value={value.follow_up_reason} onChange={set('follow_up_reason')} />
          </FieldRow>

          <FieldRow label="Timeframe (days)" hint="Days until next call.">
            <input
              type="number" min="0" max="365"
              value={value.follow_up_timeframe_days ?? ''}
              onChange={e => set('follow_up_timeframe_days')(e.target.value === '' ? null : Number(e.target.value))}
              style={{ width: 80, padding: '4px 6px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit' }}
            />
          </FieldRow>

          {(value.follow_up_timeframe_days ?? 0) > 4 && (
            <FieldRow label="Why so far out?" hint="Required when > 4 days.">
              <textarea
                value={value.follow_up_timeframe_reason || ''}
                onChange={e => set('follow_up_timeframe_reason')(e.target.value)}
                rows={2}
                style={{ width: '100%', padding: '6px 8px', fontSize: 12, border: hair, borderRadius: 4, fontFamily: 'inherit', resize: 'vertical' }}
              />
            </FieldRow>
          )}
        </>
      )}

      {isNoClose && (
        <>
          <FieldRow label="Objection" hint="Main reason they didn't close.">
            <Pills options={OBJECTIONS} value={value.objection_category} onChange={set('objection_category')} />
          </FieldRow>

          <FieldRow label="Next state" hint="Where does this prospect go now?">
            <Pills options={NEXT_STATES} value={value.next_state} onChange={set('next_state')} />
          </FieldRow>
        </>
      )}

      {value.reason_alignment && value.reason_alignment !== 'n/a' && (
        <FieldRow label="Reason alignment" hint="Auto-computed vs prior call.">
          <span style={{
            padding: '3px 8px', fontSize: 11, borderRadius: 4,
            background: value.reason_alignment === 'aligned' ? 'rgba(48,164,108,0.1)' : 'rgba(204,55,55,0.1)',
            color: value.reason_alignment === 'aligned' ? '#1f7a4d' : neg,
          }}>
            {value.reason_alignment === 'aligned' ? '✓ Aligned' : '⚠ Misaligned — first-call objection may have been a smokescreen'}
          </span>
        </FieldRow>
      )}
    </div>
  )
}
