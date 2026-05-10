import { useState, useRef, useEffect } from 'react'
import { Sparkles, Loader, Send, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  Audience Ideation tab — implements Jeremy Haynes' Problems × Circumstances ×
  Outcomes framework for generating messaging concepts grounded in real sales
  call transcripts.

  Flow:
   1. Operator picks a BRAND (RestorationConnect, PlumberConnect, etc.)
   2. Operator picks an AUDIENCE archetype (e.g. "Restoration owner doing
      $50k+/mo, runs Google ads but hates the lead quality, scared of
      committing to another agency")
   3. Generate -> Edge Function (ad-analyst with mode='audience_ideation')
      pulls Daniel's prospect calls + phrase data, frames Problems ×
      Circumstances × Outcomes, returns 5-7 messaging concepts as bullet
      points with example hooks
   4. Operator can chat-refine ("make it more aggressive", "lean into
      cost-savings angle", etc.) - Claude streams responses

  No persistence yet — each session is ephemeral. Saving to
  library.audience_pockets is a future enhancement.
*/

const BRANDS = [
  { id: 'restoration',  label: 'RestorationConnect',  hint: 'Water/fire/mold damage restoration companies' },
  { id: 'plumbing',     label: 'PlumberConnect',      hint: 'Plumbing contractors' },
  { id: 'pool',         label: 'PoolConnect',         hint: 'Pool service / construction' },
  { id: 'remodeling',   label: 'RemodelingAI',        hint: 'Home remodeling contractors' },
  { id: 'opt_direct',   label: 'OPT Digital direct',  hint: 'Agencies / coaches selling B2B' },
]

const AUDIENCE_PROMPTS = [
  '$50k+/mo restoration owner burned by previous agency, skeptical of paid ads',
  'Plumber stuck at $20-30k/mo, no marketing system, leads from word-of-mouth only',
  'Pool company owner scaling past first hire, drowning in admin, needs predictable lead flow',
  'Remodeler with 1-2 employees, jobs lined up for 3 months but never knows where next quarter\'s work comes from',
  'Agency owner at $80-150k/mo MRR, ceiling-hit on outbound, wants paid acquisition that doesn\'t cannibalize margin',
]

export default function AdsIdeationPanel() {
  const [brand, setBrand] = useState(BRANDS[0].id)
  const [audience, setAudience] = useState('')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [conversation, setConversation] = useState([]) // [{ role, content }]
  const [followUp, setFollowUp] = useState('')
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [conversation, generating])

  const generate = async () => {
    if (!audience.trim() || generating) return
    setError(null)
    setGenerating(true)
    setConversation([])  // fresh session per generate

    const brandLabel = BRANDS.find(b => b.id === brand)?.label || brand
    const userMsg = `Brand: ${brandLabel}\nAudience: ${audience.trim()}`
    setConversation([{ role: 'user', content: userMsg }])

    try {
      const { data, error } = await supabase.functions.invoke('ad-analyst', {
        body: {
          mode: 'audience_ideation',
          brand: brandLabel,
          audience: audience.trim(),
        },
      })
      if (error) throw new Error(error.message || 'audience-ideation failed')
      if (data?.error) throw new Error(data.error)
      setConversation(prev => [...prev, { role: 'assistant', content: data.reply || '' }])
    } catch (e) {
      console.error('[ideation] generate failed:', e)
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const sendFollowUp = async () => {
    if (!followUp.trim() || generating) return
    setError(null)
    setGenerating(true)
    const nextHistory = [...conversation, { role: 'user', content: followUp.trim() }]
    setConversation(nextHistory)
    setFollowUp('')

    try {
      const { data, error } = await supabase.functions.invoke('ad-analyst', {
        body: {
          mode: 'audience_ideation_followup',
          messages: nextHistory.map(({ role, content }) => ({ role, content })),
        },
      })
      if (error) throw new Error(error.message || 'follow-up failed')
      if (data?.error) throw new Error(data.error)
      setConversation(prev => [...prev, { role: 'assistant', content: data.reply || '' }])
    } catch (e) {
      console.error('[ideation] follow-up failed:', e)
      setError(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const clear = () => { setConversation([]); setAudience(''); setError(null) }

  const onAudienceKey = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      generate()
    }
  }

  const onFollowUpKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendFollowUp()
    }
  }

  return (
    <div>
      {/* Sub-tab header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Audience · ideation</span>
          <h2 className="h3 mt-2" style={{ fontSize: 20 }}>Messaging by <em>audience archetype</em>.</h2>
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
            Problems · circumstances · outcomes · per Jeremy Haynes
          </p>
        </div>
      </div>

      {/* Inputs panel */}
      <div
        style={{
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          padding: 20,
          marginBottom: 24,
        }}
      >
        {/* Brand picker */}
        <div style={{ marginBottom: 18 }}>
          <label className="kicker" style={{ display: 'block', marginBottom: 8 }}>Offer / niche</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {BRANDS.map(b => (
              <button
                key={b.id}
                onClick={() => setBrand(b.id)}
                title={b.hint}
                style={{
                  padding: '6px 12px',
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  fontWeight: 500,
                  background: brand === b.id ? 'var(--ink)' : 'var(--paper-2)',
                  color: brand === b.id ? 'var(--paper)' : 'var(--ink-2)',
                  border: '1px solid',
                  borderColor: brand === b.id ? 'var(--ink)' : 'var(--rule)',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* Audience input */}
        <div style={{ marginBottom: 12 }}>
          <label className="kicker" style={{ display: 'block', marginBottom: 8 }}>
            Audience archetype <span style={{ color: 'var(--ink-4)', fontStyle: 'italic', textTransform: 'none', letterSpacing: 'normal' }}>· describe the specific person we're targeting</span>
          </label>
          <textarea
            value={audience}
            onChange={e => setAudience(e.target.value)}
            onKeyDown={onAudienceKey}
            placeholder="e.g. $50k+/mo restoration owner burned by previous agency, skeptical of paid ads, runs Google + word-of-mouth but lead quality is mixed…"
            rows={3}
            style={{
              width: '100%',
              background: 'var(--paper-2)',
              border: '1px solid var(--rule)',
              borderRadius: 3,
              padding: '10px 12px',
              fontFamily: 'var(--serif)',
              fontSize: 14,
              lineHeight: 1.45,
              color: 'var(--ink)',
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Suggested archetypes */}
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              marginBottom: 6,
              display: 'inline-flex',
            }}
          >
            Suggested
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {AUDIENCE_PROMPTS.map((p, i) => (
              <button
                key={i}
                onClick={() => setAudience(p)}
                style={{
                  textAlign: 'left',
                  padding: '6px 10px',
                  background: 'transparent',
                  color: 'var(--ink-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 2,
                  fontFamily: 'var(--serif)',
                  fontSize: 13,
                  fontStyle: 'italic',
                  cursor: 'pointer',
                  transition: 'background 160ms ease, border-color 160ms ease',
                  lineHeight: 1.35,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-2)'; e.currentTarget.style.borderColor = 'var(--ink-3)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'var(--rule)' }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Generate button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={generate}
            disabled={!audience.trim() || generating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              background: audience.trim() && !generating ? 'var(--accent)' : 'var(--paper-2)',
              color: 'var(--ink)',
              border: '1px solid',
              borderColor: audience.trim() && !generating ? 'var(--accent)' : 'var(--rule)',
              borderRadius: 3,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              fontWeight: 600,
              cursor: !audience.trim() || generating ? 'not-allowed' : 'pointer',
              opacity: !audience.trim() ? 0.5 : 1,
            }}
          >
            {generating ? <Loader size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {generating ? 'Generating…' : 'Generate messaging'}
          </button>
          {conversation.length > 0 && (
            <button
              onClick={clear}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '8px 12px',
                background: 'transparent',
                color: 'var(--ink-3)',
                border: '1px solid var(--rule)',
                borderRadius: 3,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              <Trash2 size={11} /> Clear
            </button>
          )}
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.08em',
              color: 'var(--ink-4)',
              marginLeft: 'auto',
            }}
          >
            Ctrl+Enter to generate
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--down-soft)',
            border: '1px solid var(--down)',
            borderLeftWidth: 3,
            borderRadius: '0 3px 3px 0',
            color: 'var(--down)',
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          <strong style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>Ideation error</strong>
          {error}
        </div>
      )}

      {/* Conversation thread */}
      {conversation.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div
            style={{
              background: 'var(--paper)',
              border: '1px solid var(--rule)',
              borderRadius: 4,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            {conversation.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content} />
            ))}
            {generating && (
              <Bubble role="assistant" content="Pulling transcripts + phrase data, framing problems × circumstances × outcomes…" working />
            )}
            <div ref={scrollRef} />
          </div>

          {/* Follow-up input */}
          {!generating && conversation.length > 0 && conversation[conversation.length - 1].role === 'assistant' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
              <textarea
                value={followUp}
                onChange={e => setFollowUp(e.target.value)}
                onKeyDown={onFollowUpKey}
                placeholder="Refine: 'make it more aggressive', 'lean into cost-savings', 'give me a hook for #3'…"
                rows={1}
                style={{
                  flex: 1,
                  background: 'var(--paper-2)',
                  border: '1px solid var(--rule)',
                  borderRadius: 3,
                  padding: '8px 10px',
                  fontSize: 13,
                  fontFamily: 'var(--sans)',
                  color: 'var(--ink)',
                  outline: 'none',
                  resize: 'none',
                  minHeight: 36,
                  maxHeight: 120,
                }}
              />
              <button
                onClick={sendFollowUp}
                disabled={!followUp.trim() || generating}
                style={{
                  width: 36, height: 36,
                  background: followUp.trim() ? 'var(--accent)' : 'var(--paper-2)',
                  border: '1px solid',
                  borderColor: followUp.trim() ? 'var(--accent)' : 'var(--rule)',
                  color: 'var(--ink)',
                  borderRadius: 3,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: followUp.trim() ? 'pointer' : 'not-allowed',
                  flexShrink: 0,
                }}
              >
                <Send size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="what-it-means">
        <div className="wim-tag">How this works</div>
        <div className="wim-body">
          Pick a niche and describe one specific audience type. The agent pulls <em>Daniel's prospect call transcripts</em> filtered to that brand, plus the top-decile phrases from your ad copy, and runs them through the <em>Problems × Circumstances × Outcomes</em> framework. You get 5-7 messaging concepts grounded in what prospects actually said in real calls — not generic copywriting boilerplate. Then refine in the chat.
        </div>
      </div>
    </div>
  )
}

function Bubble({ role, content, working }) {
  const isUser = role === 'user'
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '88%',
          padding: '12px 14px',
          borderRadius: 3,
          background: isUser ? 'var(--accent-soft)' : 'var(--paper-2)',
          border: `1px solid ${isUser ? 'var(--accent)' : 'var(--rule)'}`,
          color: 'var(--ink)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            marginBottom: 6,
            fontWeight: 500,
          }}
        >
          {isUser ? 'You · brief' : 'Analyst'}
        </div>
        <div
          style={{
            fontFamily: isUser ? 'var(--sans)' : 'var(--serif)',
            fontSize: isUser ? 13 : 14,
            fontStyle: working ? 'italic' : 'normal',
            color: working ? 'var(--ink-3)' : 'inherit',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {content}
        </div>
      </div>
    </div>
  )
}
