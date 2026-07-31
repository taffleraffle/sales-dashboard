import { useState, useMemo, useEffect } from 'react'
import DateRangeSelector from '../components/DateRangeSelector'
import KPICard from '../components/KPICard'
import Gauge from '../components/Gauge'
import { useEngagementData } from '../hooks/useEngagementData'
import { useEngagementCadences } from '../hooks/useEngagementCadences'
import { Bot, Loader2, ChevronDown, ChevronUp, Filter, Zap, Phone, RefreshCw, Check, Save, Power, Clock, AlertTriangle, MessageSquare, Pause, Play, Send } from 'lucide-react'
import { supabase } from '../lib/supabase'

const SEQ_COLORS = {
  pre_call: 'bg-emerald-500/20 text-emerald-400',
  after_hours: 'bg-bg-card text-text-secondary',
  post_call: 'bg-purple-500/20 text-purple-400',
  re_engage: 'bg-amber-500/20 text-amber-400',
  non_responsive_confirm: 'bg-red-500/20 text-red-400',
}

const STATUS_COLORS = {
  active: 'bg-emerald-500/20 text-emerald-400',
  completed: 'bg-text-400/20 text-text-secondary',
  handed_off: 'bg-amber-500/20 text-amber-400',
  stopped: 'bg-red-500/20 text-red-400',
}

const SEQ_LABELS = {
  pre_call: 'Pre-Call',
  after_hours: 'Speed to Lead',
  post_call: 'Post-Call',
  re_engage: 'Re-Engage',
  non_responsive_confirm: 'Non-Responsive',
}

function Badge({ text, colorMap }) {
  const cls = colorMap?.[text] || 'bg-text-400/20 text-text-secondary'
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${cls}`}>
      {SEQ_LABELS[text] || (text || 'unknown').replace(/_/g, ' ')}
    </span>
  )
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatTime(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' })
}

function formatHour(h) {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

const CADENCE_ICONS = {
  speed_to_lead: Zap,
  call_confirmation: Phone,
  re_engage: RefreshCw,
}

const CADENCE_DESCRIPTIONS = {
  speed_to_lead: 'Automatically reaches out to new leads after business hours when no setter is available.',
  call_confirmation: 'Sends confirmation messages before scheduled calls and escalates non-responsive leads.',
  re_engage: 'Re-engages cold leads who haven\'t responded after a set period.',
}

const CADENCE_SEQ_MAP = {
  speed_to_lead: ['after_hours'],
  call_confirmation: ['pre_call', 'non_responsive_confirm'],
  re_engage: ['re_engage'],
}

const CADENCE_DOCS = {
  speed_to_lead: {
    title: 'How Speed to Lead Works',
    steps: [
      { label: 'Lead comes in', detail: 'A new contact is created in GHL (form submission, ad lead, etc). The GHL contact-created webhook fires.' },
      { label: 'Time check', detail: 'Bot checks if it\'s after the "After-Hours Start Time" in the lead\'s timezone (EST). If it\'s during business hours, the bot waits for the "Wait Before Contacting" timeout before stepping in.' },
      { label: 'Setter engagement check', detail: 'Bot checks if a setter has already engaged with this lead by looking at: (1) GHL conversation messages \u2014 any outbound human message, (2) WAVV call tags on the contact \u2014 wavv-interested, wavv-appointment-set, wavv-callback, wavv-not-interested, (3) WAVV call duration \u2014 any call over 60 seconds counts as a meaningful conversation. If any of these are true, the bot stands down.' },
      { label: 'First text', detail: 'If no setter has contacted them, the bot sends a casual intro text as the assigned setter. Asks what the biggest problem is. Does NOT mention maps, SEO, or anything technical.' },
      { label: 'Conversation', detail: 'If they reply, the bot qualifies them: what\'s the gap, what have they tried, why now. Keeps it short and curious.' },
      { label: 'Book an intro call', detail: 'Once qualified, the bot transitions to booking a quick phone call. NOT a strategy session. Just an intro ring.' },
    ],
    data_source: 'GHL webhook (contact-created) triggers the bot. Setter engagement checked via: GHL Conversations API (outbound messages not from API), GHL contact tags (WAVV tags: wavv-interested, wavv-appointment-set, wavv-callback, wavv-not-interested = pickup; wavv-no-answer, wavv-left-voicemail = no contact), and wavv_calls table (call_duration > 60s = meaningful conversation, < 60s = missed or brief). Contact details, notes, and assigned setter pulled from GHL API.',
  },
  call_confirmation: {
    title: 'How Call Confirmation Works',
    steps: [
      { label: 'Poll upcoming calls', detail: 'Every 5 minutes, the bot checks GHL calendar for strategy calls coming up in the next 26 hours.' },
      { label: 'Filter unconfirmed', detail: 'For each upcoming call, the bot checks: (1) Has the prospect replied to ANY text messages? Checked via last_prospect_reply_at in the engagement_conversations table. (2) Was there a meaningful WAVV call? Checks GHL contact tags for wavv-interested, wavv-appointment-set, or wavv-callback. Also checks wavv_calls table for any call over 60 seconds with this contact. If NEITHER a text reply NOR a meaningful call exists, the lead is flagged as unconfirmed.' },
      { label: 'Open with a question', detail: 'The bot texts as the assigned setter and asks a specific question the closer "needs confirmed" before the call (primary service, target area, etc). The goal is to get them to REPLY, not just confirm logistics.' },
      { label: 'Follow-up if no reply', detail: 'If still no reply, the bot bumps the message. Tries a different angle (verify business address, confirm service area). Also sends the meeting link.' },
      { label: 'Escalation', detail: 'If the prospect hasn\'t replied by the "Non-Responsive Alert" threshold (default 4h before call), the bot sends a direct confirmation with the meeting link and alerts the team via Slack about a potential no-show.' },
      { label: 'Meeting link', detail: 'The bot pulls the calendar invite meeting link from the GHL appointment and includes it in confirmation texts so the prospect has it right at the top of their messages.' },
    ],
    data_source: 'GHL Calendar API polled every 5 min for upcoming strategy calls. Reply status from engagement_conversations.last_prospect_reply_at. WAVV engagement from GHL contact tags (wavv-interested, wavv-appointment-set, wavv-callback = contacted; wavv-no-answer = not contacted) and wavv_calls table (call_duration > 60s = meaningful conversation). Appointment details, assigned closer name, and meeting link from GHL Calendar API.',
  },
  re_engage: {
    title: 'How Re-engagement Works',
    steps: [
      { label: 'Hourly scan', detail: 'Every hour, the bot scans the engagement_conversations table for leads where the last message was sent 48+ hours ago (configurable) with no reply.' },
      { label: 'Eligibility check', detail: 'Skips leads who previously asked to stop, leads where a setter has manually engaged since, and leads who already have an active re-engagement sequence.' },
      { label: 'Step 1: Fresh angle', detail: 'First re-engagement text. Does NOT reference that they didn\'t reply. Comes in with a completely new angle based on their notes/trade.' },
      { label: 'Step 2: Value drop', detail: 'After the configured gap (default 2 days), sends something useful or a quick insight. "Saw this and thought of you" energy.' },
      { label: 'Step 3: Last chance', detail: 'Final attempt (default day 5). Direct but warm. Gives them an easy out. "No worries if the timing isn\'t right."' },
      { label: 'Sequence complete', detail: 'After step 3, the conversation is marked as completed. The lead won\'t be re-engaged again unless a new appointment is booked.' },
    ],
    data_source: 'Supabase engagement_conversations table scanned hourly. Filters by last_prospect_reply_at (NULL or older than threshold) and updated_at. GHL contact data pulled for context when generating messages.',
  },
}

function CadenceDocPanel({ cadenceName }) {
  const doc = CADENCE_DOCS[cadenceName]
  if (!doc) return null

  return (
    <div className="space-y-4">
      <h4 className="text-xs font-bold text-text-primary">{doc.title}</h4>
      <div className="space-y-2.5">
        {doc.steps.map((step, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex-shrink-0 w-5 h-5 rounded-full bg-opt-yellow/10 flex items-center justify-center mt-0.5">
              <span className="text-[9px] font-bold text-text-primary">{i + 1}</span>
            </div>
            <div>
              <p className="text-xs font-medium text-text-primary">{step.label}</p>
              <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 pt-3 border-t border-border-default/30">
        <p className="text-[10px] text-text-400 uppercase font-medium mb-1">Data Source</p>
        <p className="text-[11px] text-text-secondary leading-relaxed">{doc.data_source}</p>
      </div>
    </div>
  )
}

function CadenceCard({ cadence, conversations, onSave }) {
  const [enabled, setEnabled] = useState(cadence.enabled)
  const [rules, setRules] = useState(cadence.trigger_rules || {})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [showDoc, setShowDoc] = useState(false)

  const Icon = CADENCE_ICONS[cadence.name] || Zap
  const description = CADENCE_DESCRIPTIONS[cadence.name] || ''
  const seqTypes = CADENCE_SEQ_MAP[cadence.name] || []
  const cadenceConvos = conversations.filter(c => seqTypes.includes(c.sequence_type))
  const lastFired = cadenceConvos.length > 0 ? cadenceConvos[0]?.created_at : null
  const replied = cadenceConvos.filter(c => c.last_prospect_reply_at).length
  const replyRate = cadenceConvos.length > 0 ? ((replied / cadenceConvos.length) * 100).toFixed(0) : 0

  const hasChanges = enabled !== cadence.enabled ||
    JSON.stringify(rules) !== JSON.stringify(cadence.trigger_rules || {})

  const handleSave = async () => {
    setSaving(true)
    const ok = await onSave(cadence.id, { enabled, trigger_rules: rules })
    setSaving(false)
    if (ok) { setSaved(true); setTimeout(() => setSaved(false), 3000) }
  }

  const toggleEnabled = async () => {
    const next = !enabled
    setEnabled(next)
    setSaving(true)
    const ok = await onSave(cadence.id, { enabled: next, trigger_rules: rules })
    setSaving(false)
    setSaved(ok)
    if (ok) setTimeout(() => setSaved(false), 3000)
  }

  const updateRule = (key, value) => setRules(prev => ({ ...prev, [key]: value }))

  const ruleCls = 'w-full py-2 px-3 bg-bg-primary border border-border-default rounded-lg text-sm text-text-primary text-center focus:outline-none focus:border-opt-yellow/40 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'

  return (
    <div className={`bg-bg-card border rounded-sm overflow-hidden transition-all hover:border-opt-yellow/20 ${enabled ? 'border-border-default' : 'border-border-default/40'}`}>
      {/* Header */}
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-sm flex items-center justify-center transition-colors ${enabled ? 'bg-opt-yellow/10' : 'bg-text-400/10'}`}>
              <Icon size={18} className={enabled ? 'text-text-primary' : 'text-text-400'} />
            </div>
            <div>
              <p className="text-text-primary font-bold text-sm">{cadence.display_name}</p>
              <p className="text-text-400 text-[10px]">{description}</p>
            </div>
          </div>
          {/* ON/OFF Toggle */}
          <button
            onClick={toggleEnabled}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              enabled
                ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30'
                : 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20'
            }`}
          >
            <Power size={12} />
            {enabled ? 'Active' : 'Disabled'}
          </button>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 text-[10px] text-text-400">
          <span className="flex items-center gap-1"><MessageSquare size={10} /> {cadenceConvos.length} leads</span>
          <span className="flex items-center gap-1"><Check size={10} className="text-emerald-400" /> {replyRate}% reply rate</span>
          {lastFired && <span className="flex items-center gap-1"><Clock size={10} /> Last: {timeAgo(lastFired)}</span>}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex border-t border-border-default/50">
        <button
          onClick={() => { setShowDoc(!showDoc); if (!showDoc) setExpanded(false) }}
          className={`flex-1 px-5 py-2.5 flex items-center justify-center gap-1.5 text-[10px] transition-colors border-r border-border-default/50 ${
            showDoc ? 'text-text-primary bg-opt-yellow-subtle' : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
          }`}
        >
          <AlertTriangle size={11} />
          {showDoc ? 'Hide docs' : 'How it works'}
        </button>
        <button
          onClick={() => { setExpanded(!expanded); if (!expanded) setShowDoc(false) }}
          className={`flex-1 px-5 py-2.5 flex items-center justify-center gap-1.5 text-[10px] transition-colors ${
            expanded ? 'text-text-primary bg-opt-yellow-subtle' : 'text-text-400 hover:text-text-primary hover:bg-bg-card-hover'
          }`}
        >
          {expanded ? <><ChevronUp size={12} /> Hide settings</> : <><ChevronDown size={12} /> Configure</>}
        </button>
      </div>

      {/* How it works doc */}
      {showDoc && (
        <div className="px-5 pb-5 pt-4 border-t border-border-default/50 bg-opt-yellow-subtle/30">
          <CadenceDocPanel cadenceName={cadence.name} />
        </div>
      )}

      {expanded && (
        <div className="px-5 pb-5 pt-3 border-t border-border-default/50 bg-bg-primary/30">
          {/* Trigger Rules — clear labels */}
          <div className="space-y-3">
            {cadence.name === 'speed_to_lead' && (
              <>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">After-Hours Start Time</label>
                  <p className="text-[9px] text-text-400 mb-1.5">Bot activates after this hour (leads arriving after business hours)</p>
                  <div className="flex items-center gap-2">
                    <select
                      value={rules.after_hours_cutoff ?? 17}
                      onChange={e => updateRule('after_hours_cutoff', parseInt(e.target.value))}
                      className={ruleCls + ' w-auto'}
                    >
                      {Array.from({ length: 24 }, (_, i) => (
                        <option key={i} value={i}>{formatHour(i)}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">Wait Before Contacting</label>
                  <p className="text-[9px] text-text-400 mb-1.5">Minutes to wait for a setter to claim the lead before bot reaches out</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={1} max={60}
                      value={rules.no_contact_minutes ?? 5}
                      onChange={e => updateRule('no_contact_minutes', parseInt(e.target.value) || 5)}
                      className={ruleCls + ' w-20'}
                    />
                    <span className="text-text-400 text-xs">minutes</span>
                  </div>
                </div>
              </>
            )}
            {cadence.name === 'call_confirmation' && (
              <>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">Confirmation Window</label>
                  <p className="text-[9px] text-text-400 mb-1.5">How many hours before the call to send a confirmation message</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={1} max={72}
                      value={rules.no_reply_hours ?? 24}
                      onChange={e => updateRule('no_reply_hours', parseInt(e.target.value) || 24)}
                      className={ruleCls + ' w-20'}
                    />
                    <span className="text-text-400 text-xs">hours before call</span>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">Non-Responsive Alert</label>
                  <p className="text-[9px] text-text-400 mb-1.5">If lead hasn't replied by this many hours before the call, flag as at-risk</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={1} max={12}
                      value={rules.non_responsive_at_hours ?? 4}
                      onChange={e => updateRule('non_responsive_at_hours', parseInt(e.target.value) || 4)}
                      className={ruleCls + ' w-20'}
                    />
                    <span className="text-text-400 text-xs">hours before call</span>
                  </div>
                </div>
              </>
            )}
            {cadence.name === 're_engage' && (
              <>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">Cold Lead Threshold</label>
                  <p className="text-[9px] text-text-400 mb-1.5">Hours of no reply before the lead is considered cold and re-engagement starts</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={12} max={168}
                      value={rules.stale_hours ?? 48}
                      onChange={e => updateRule('stale_hours', parseInt(e.target.value) || 48)}
                      className={ruleCls + ' w-20'}
                    />
                    <span className="text-text-400 text-xs">hours</span>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-text-primary uppercase font-medium block mb-1">Follow-Up Schedule</label>
                  <p className="text-[9px] text-text-400 mb-1.5">Days after going cold to send each follow-up (comma separated)</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={(rules.steps_days || [0, 2, 5]).join(', ')}
                      onChange={e => updateRule('steps_days', e.target.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)))}
                      className={ruleCls + ' w-32'}
                      placeholder="0, 2, 5"
                    />
                    <span className="text-text-400 text-xs">days</span>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Save Button — always visible */}
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border-default/30">
            <div>
              {saved && <span className="flex items-center gap-1 text-xs text-success font-medium"><Check size={12} /> Settings saved</span>}
              {hasChanges && !saved && <span className="text-[10px] text-warning">Unsaved changes</span>}
            </div>
            <button
              onClick={handleSave}
              disabled={saving || !hasChanges}
              className="flex items-center gap-1.5 px-5 py-2 text-xs font-medium bg-opt-yellow text-text-primary rounded-lg hover:bg-opt-yellow/90 disabled:opacity-30 transition-all"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const AGENT_URL = import.meta.env.VITE_ENGAGEMENT_AGENT_URL
const AGENT_ADMIN_KEY = import.meta.env.VITE_AGENT_ADMIN_KEY

function ConversationRow({ convo }) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(convo.status)
  const [saving, setSaving] = useState(false)
  const [messages, setMessages] = useState(convo.messages || [])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState('')
  const lastMsg = messages.slice(-1)[0]

  // Pause = flip status to handed_off; the bot only touches conversations
  // whose status is 'active', so this silences it for this lead only.
  // 'stopped' is never resumable from here — the lead asked out.
  const setBotStatus = async (next) => {
    setSaving(true)
    const { error } = await supabase
      .from('engagement_conversations')
      .update({
        status: next,
        stop_reason: next === 'handed_off' ? 'paused_from_dashboard' : null,
      })
      .eq('id', convo.id)
    if (!error) setStatus(next)
    setSaving(false)
  }

  // Send a text into this conversation as the setter via the engagement
  // agent. The agent sends through Linq and flips the convo to handed_off,
  // so the bot goes quiet — a human has taken over.
  const sendReply = async () => {
    const text = replyText.trim()
    if (!text) return
    setSendErr('')
    if (!AGENT_URL || !AGENT_ADMIN_KEY) {
      setSendErr('Messaging not configured (missing agent URL or key).')
      return
    }
    setSending(true)
    try {
      const res = await fetch(`${AGENT_URL}/admin/conversations/${convo.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': AGENT_ADMIN_KEY },
        body: JSON.stringify({ message: text }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail.detail || `Send failed (${res.status})`)
      }
      setMessages(prev => [...prev, { direction: 'outbound', content: text, time: new Date().toISOString() }])
      setReplyText('')
      setStatus('handed_off') // agent pauses the bot on takeover
    } catch (err) {
      setSendErr(err.message || 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <tr
        className="border-b border-border-default/30 hover:bg-bg-card-hover/50 transition-colors cursor-pointer group"
        onClick={() => setExpanded(!expanded)}
      >
        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2">
            <ChevronDown size={12} className={`text-text-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            <div>
              <p className="text-sm text-text-primary font-medium group-hover:text-text-primary transition-colors">{convo.prospect_name || 'Unknown'}</p>
              <p className="text-[10px] text-text-400 font-mono">{convo.prospect_phone}</p>
            </div>
          </div>
        </td>
        <td className="py-2.5 px-3"><Badge text={convo.sequence_type} colorMap={SEQ_COLORS} /></td>
        <td className="py-2.5 px-3"><Badge text={status} colorMap={STATUS_COLORS} /></td>
        <td className="py-2.5 px-3 text-sm text-text-primary">{messages.length}</td>
        <td className="py-2.5 px-3">
          {convo.last_prospect_reply_at
            ? <span className="text-emerald-400 text-xs flex items-center gap-1"><Check size={10} /> Replied</span>
            : <span className="text-text-400 text-xs">No reply</span>
          }
        </td>
        <td className="py-2.5 px-3 text-sm text-text-secondary">{convo.setter_name || ''}</td>
        <td className="py-2.5 px-3 text-xs text-text-400">{timeAgo(convo.updated_at)}</td>
        <td className="py-2.5 px-3 text-xs text-text-secondary max-w-[200px] truncate">
          {lastMsg?.direction === 'inbound' && <span className="text-emerald-400 mr-1">&larr;</span>}
          {lastMsg?.direction === 'outbound' && <span className="text-text-secondary mr-1">&rarr;</span>}
          {lastMsg?.content?.slice(0, 50) || ''}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="p-0">
            <div className="bg-bg-primary/50 border-t border-border-default px-6 py-4 max-h-[400px] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] text-text-primary uppercase tracking-wider font-semibold">Conversation History</p>
                <div className="flex items-center gap-3">
                  {status === 'active' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setBotStatus('handed_off') }}
                      disabled={saving}
                      className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-amber-400 border border-amber-400/40 rounded-sm px-2 py-1 hover:bg-amber-400/10 transition-colors disabled:opacity-50"
                      title="Bot stops messaging this lead. A human takes over (reply from the Linq app)."
                    >
                      {saving ? <Loader2 size={10} className="animate-spin" /> : <Pause size={10} />} Pause bot
                    </button>
                  )}
                  {status === 'handed_off' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setBotStatus('active') }}
                      disabled={saving}
                      className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-emerald-400 border border-emerald-400/40 rounded-sm px-2 py-1 hover:bg-emerald-400/10 transition-colors disabled:opacity-50"
                      title="Bot resumes handling replies in this conversation."
                    >
                      {saving ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} />} Resume bot
                    </button>
                  )}
                  {status === 'stopped' && (
                    <span className="text-[10px] text-text-400">Lead opted out — bot locked off</span>
                  )}
                  {convo.appointment_time && (
                    <p className="text-[10px] text-text-400">Call: {formatTime(convo.appointment_time)}</p>
                  )}
                </div>
              </div>
              {messages.length === 0 ? (
                <p className="text-text-400 text-sm">No messages yet</p>
              ) : (
                <div className="space-y-2">
                  {messages.map((msg, i) => {
                    const isBot = msg.source === 'bot'
                    const senderLabel = msg.direction !== 'outbound'
                      ? (convo.prospect_name || 'Prospect')
                      : isBot ? 'Bot' : (convo.setter_name || 'Josh')
                    return (
                    <div key={i} className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-sm px-3 py-2 border ${
                        msg.direction !== 'outbound'
                          ? 'bg-bg-card border-border-default'
                          : isBot
                            ? 'bg-red-500/10 border-red-500/30'
                            : 'bg-bg-card-hover border-border-default'
                      }`}>
                        <p className="text-sm text-text-primary">{msg.content}</p>
                        <p className="text-[9px] mt-1">
                          <span className={isBot ? 'text-red-400 font-medium' : 'text-text-400'}>
                            {senderLabel}{isBot && ' \u00b7 auto'}
                          </span>
                          {msg.time && <span className="text-text-400">{` \u00b7 ${formatTime(msg.time)}`}</span>}
                        </p>
                      </div>
                    </div>
                    )
                  })}
                </div>
              )}

              {/* Human takeover reply box \u2014 sending pauses the bot for this lead */}
              {status === 'stopped' ? (
                <p className="mt-4 text-[10px] text-text-400 border-t border-border-default/50 pt-3">
                  Lead opted out \u2014 messaging is locked.
                </p>
              ) : (
                <div className="mt-4 border-t border-border-default/50 pt-3" onClick={e => e.stopPropagation()}>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={replyText}
                      onChange={e => setReplyText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                      placeholder={`Message ${convo.prospect_name || 'lead'} as ${convo.setter_name || 'the setter'}\u2026`}
                      rows={2}
                      disabled={sending}
                      className="flex-1 resize-none bg-bg-primary border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-400 focus:outline-none focus:border-opt-yellow/40 transition-colors disabled:opacity-50"
                    />
                    <button
                      onClick={sendReply}
                      disabled={sending || !replyText.trim()}
                      className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-opt-yellow text-text-primary rounded-lg hover:bg-opt-yellow/90 disabled:opacity-30 transition-all"
                    >
                      {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                      {sending ? 'Sending' : 'Send'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <p className="text-[9px] text-text-400">
                      Sending takes over from the bot \u2014 it stops auto-replying to this lead. {' '}
                      <span className="text-text-400/70">Enter to send · Shift+Enter for a new line.</span>
                    </p>
                    {sendErr && <span className="text-[10px] text-red-400">{sendErr}</span>}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export default function SetterBot() {
  const [range, setRange] = useState(30)
  const [leadFilter, setLeadFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const { conversations, stats, setterStats, loading } = useEngagementData(range)
  const { cadences, update: updateCadence, loading: cadencesLoading } = useEngagementCadences()

  // Live vs dry-run status pulled from the agent itself (not hardcoded).
  const [dryRun, setDryRun] = useState(null)
  useEffect(() => {
    if (!AGENT_URL) return
    fetch(`${AGENT_URL}/admin/dry-run`)
      .then(r => r.json())
      .then(d => setDryRun(!!d.dry_run))
      .catch(() => setDryRun(null))
  }, [])

  const filteredLeads = useMemo(() => {
    let filtered = [...conversations]

    if (leadFilter === 'contacted') {
      filtered = filtered.filter(c => (c.messages || []).some(m => m.direction === 'outbound'))
    } else if (leadFilter === 'replied') {
      filtered = filtered.filter(c => c.last_prospect_reply_at)
    } else if (leadFilter === 'booked') {
      filtered = filtered.filter(c => c.booking_state === 'confirmed')
    } else if (leadFilter === 'active') {
      filtered = filtered.filter(c => c.status === 'active')
    } else if (leadFilter === 'handed_off') {
      filtered = filtered.filter(c => c.status === 'handed_off')
    } else if (leadFilter === 'stopped') {
      filtered = filtered.filter(c => c.status === 'stopped')
    } else if (leadFilter === 'no_reply') {
      filtered = filtered.filter(c => !c.last_prospect_reply_at && (c.messages || []).some(m => m.direction === 'outbound'))
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(c =>
        (c.prospect_name || '').toLowerCase().includes(q) ||
        (c.prospect_phone || '').includes(q) ||
        (c.setter_name || '').toLowerCase().includes(q)
      )
    }

    return filtered
  }, [conversations, leadFilter, searchQuery])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-text-primary" />
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4 mb-7 pb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">OPT Sales · Setter bot</span>
          <div className="flex items-center gap-3 mt-2">
            <h1 className="h2">The <em>autonomous</em> setter.</h1>
            {dryRun === false && (
              <span className="tag" style={{ background: '#d6f5e0', color: '#0a6b39', borderColor: '#8fd6ab' }}>Live</span>
            )}
            {dryRun === true && (
              <span className="tag" style={{ background: '#fff4d6', color: '#8a5a00', borderColor: '#d6b876' }}>Dry run</span>
            )}
          </div>
          <p
            className="mt-2"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
            }}
          >
            Automated lead engagement · follow-up
          </p>
        </div>
        <DateRangeSelector selected={range} onChange={setRange} />
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 mb-6">
        <KPICard label="Conversations" value={stats.total} />
        <KPICard label="Active" value={stats.active} />
        <KPICard label="Reply Rate" value={`${stats.replyRate}%`} />
        <KPICard label="Sent" value={stats.outbound} />
        <KPICard label="Received" value={stats.inbound} />
        <KPICard label="Booked" value={stats.booked} />
        <KPICard label="Handoffs" value={stats.handedOff} />
        <KPICard label="Stopped" value={stats.stopped} />
      </div>

      {/* Gauge Row */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Gauge label="Reply Rate" value={parseFloat(stats.replyRate) || 0} target={40} />
        <Gauge label="Booking Rate" value={parseFloat(stats.bookingRate) || 0} target={15} />
        <Gauge label="Handoff Rate" value={stats.total > 0 ? parseFloat(((stats.handedOff / stats.total) * 100).toFixed(1)) : 0} target={10} direction="below" />
      </div>

      {/* Cadences */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">Cadences</h2>
        <span className="text-[10px] text-text-400">Click a cadence to configure trigger rules</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {cadences.map(c => (
          <CadenceCard key={c.id} cadence={c} conversations={conversations} onSave={updateCadence} />
        ))}
        {cadences.length === 0 && !cadencesLoading && (
          <p className="text-text-400 text-sm col-span-3">No cadences configured</p>
        )}
      </div>

      {/* Sequence Breakdown + Setter Cards Row */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        <div className="tile tile-feedback p-5 hover:border-opt-yellow/10 transition-colors">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-3">By Sequence</h2>
          <div className="space-y-2">
            {Object.entries(stats.bySequence).map(([seq, count]) => (
              <div key={seq} className="flex items-center justify-between py-1 hover:bg-bg-card-hover/30 rounded px-1 transition-colors">
                <Badge text={seq} colorMap={SEQ_COLORS} />
                <span className="text-text-primary font-bold">{count}</span>
              </div>
            ))}
            {Object.keys(stats.bySequence).length === 0 && (
              <p className="text-text-400 text-sm">No data yet</p>
            )}
          </div>
        </div>

        {setterStats.map(s => (
          <div key={s.id} className="tile tile-feedback p-5 hover:border-opt-yellow/10 transition-colors">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-8 h-8 rounded-full bg-opt-yellow/10 flex items-center justify-center">
                <span className="text-text-primary font-bold text-sm">{s.name?.[0]}</span>
              </div>
              <div>
                <p className="text-text-primary font-semibold">{s.name}</p>
                <p className="text-text-400 text-[10px] uppercase tracking-wider">{s.role}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="py-1">
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Convos</p>
                <p className="text-text-primary font-bold text-lg">{s.convos}</p>
              </div>
              <div className="py-1">
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Replies</p>
                <p className="text-text-primary font-bold text-lg">{s.replies}</p>
              </div>
              <div className="py-1">
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Reply Rate</p>
                <p className={`font-bold text-lg ${parseFloat(s.replyRate) >= 40 ? 'text-success' : 'text-text-primary'}`}>{s.replyRate}%</p>
              </div>
              <div className="py-1">
                <p className="text-text-400 text-[10px] uppercase tracking-wider">Booked</p>
                <p className="text-text-primary font-bold text-lg">{s.booked}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Leads Table */}
      <div className="tile tile-feedback overflow-hidden">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-5 border-b border-border-default">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider">All Leads</h2>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search name or phone..."
              className="bg-bg-primary border border-border-default rounded-lg px-3 py-1.5 text-xs text-text-primary placeholder:text-text-400 w-48 focus:outline-none focus:border-opt-yellow/40 transition-colors"
            />
            <div className="relative">
              <select
                value={leadFilter}
                onChange={e => setLeadFilter(e.target.value)}
                className="appearance-none bg-bg-primary border border-border-default rounded-lg px-3 py-1.5 pr-8 text-xs text-text-primary focus:outline-none focus:border-opt-yellow/40 cursor-pointer transition-colors"
              >
                <option value="all">All ({conversations.length})</option>
                <option value="contacted">Contacted ({conversations.filter(c => (c.messages || []).some(m => m.direction === 'outbound')).length})</option>
                <option value="replied">Replied ({conversations.filter(c => c.last_prospect_reply_at).length})</option>
                <option value="no_reply">No Reply ({conversations.filter(c => !c.last_prospect_reply_at && (c.messages || []).some(m => m.direction === 'outbound')).length})</option>
                <option value="booked">Booked ({conversations.filter(c => c.booking_state === 'confirmed').length})</option>
                <option value="active">Active ({conversations.filter(c => c.status === 'active').length})</option>
                <option value="handed_off">Handed Off ({conversations.filter(c => c.status === 'handed_off').length})</option>
                <option value="stopped">Stopped ({conversations.filter(c => c.status === 'stopped').length})</option>
              </select>
              <Filter size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-400 pointer-events-none" />
            </div>
          </div>
        </div>

        {filteredLeads.length === 0 ? (
          <p className="text-text-400 text-sm py-8 text-center">
            {conversations.length === 0 ? 'No conversations yet.' : 'No leads match this filter.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-default bg-bg-card">
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Prospect</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Sequence</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Status</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Msgs</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Reply</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Setter</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Activity</th>
                  <th className="text-left text-[10px] text-text-400 uppercase tracking-wider py-2 px-3">Last Message</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map(c => (
                  <ConversationRow key={c.id} convo={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-5 py-2 border-t border-border-default text-[10px] text-text-400">
          Showing {filteredLeads.length} of {conversations.length} leads
        </div>
      </div>
    </div>
  )
}
