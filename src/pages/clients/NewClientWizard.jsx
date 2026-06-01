import { useState, useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Loader, AlertCircle, Check, Sparkles, Users, FileText, ClipboardCheck, Rocket, CircleDashed } from 'lucide-react'
import { supabase } from '../../lib/supabase'

/*
  NewClientWizard — the elite client onboarding flow.

  5-step pipeline:
    1. Sources    : ingest Fathom transcript, GHL contact, existing site URL,
                    GBP profile, paste-text, etc. Each becomes a row in
                    onboarding_sources.
    2. Extraction : Anthropic processes every source against the 18-section
                    schema. Operator watches as artifacts land.
    3. Review     : Operator/AM walks each section, edits, approves.
                    Specialist suggestions surface here too.
    4. Specialist : SEO/Content/GBP/Compliance specialists add overrides,
                    additions, flags. Each suggestion shows provenance.
    5. Launch     : Quality gates checked. On pass, provisioning fires:
                    GHL opp + Slack channels + Quo number + Cloudflare project
                    + repo + drive folder + welcome email.

  State lives in `onboarding_sessions`. The wizard is resumable — closing the
  tab mid-flow doesn't lose data, and another operator can pick up where you
  left off from the queue page.
*/

const STEPS = [
  { key: 'sources',     label: 'Sources',     icon: FileText,        statuses: ['sources'] },
  { key: 'extracting',  label: 'Extraction',  icon: Sparkles,        statuses: ['extracting'] },
  { key: 'review',      label: 'Review',      icon: ClipboardCheck,  statuses: ['review'] },
  { key: 'specialist',  label: 'Specialist',  icon: Users,           statuses: ['specialist'] },
  { key: 'launch',      label: 'Launch',      icon: Rocket,          statuses: ['preview','launching','launched'] },
]

export default function NewClientWizard() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let mounted = true
    async function load() {
      setLoading(true)
      if (sessionId) {
        const { data, error: err } = await supabase
          .from('onboarding_sessions').select('*').eq('id', sessionId).single()
        if (!mounted) return
        if (err) { setError(err.message); setLoading(false); return }
        setSession(data)
      }
      setLoading(false)
    }
    load()
    return () => { mounted = false }
  }, [sessionId])

  async function createSession({ business_name_draft, vertical_draft }) {
    const { data, error: err } = await supabase
      .from('onboarding_sessions')
      .insert({
        business_name_draft,
        vertical_draft,
        initiated_by: 'operator',
        status: 'sources',
      })
      .select('*').single()
    if (err) { setError(err.message); return }
    navigate(`/clients/new/${data.id}`)
  }

  if (loading) return <div className="p-10 flex items-center justify-center"><Loader className="animate-spin text-zinc-400" /></div>

  // No session yet → show the "start a new client" form
  if (!sessionId) {
    return <NewSessionForm onCreate={createSession} error={error} />
  }

  if (!session) {
    return (
      <div className="p-6">
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 text-rose-700">{error || 'Session not found.'}</div>
        <Link to="/clients/new" className="mt-4 inline-block text-sm text-emerald-700">Start a new wizard →</Link>
      </div>
    )
  }

  const currentStepIndex = STEPS.findIndex(s => s.statuses.includes(session.status))
  const safeIndex = Math.max(0, currentStepIndex)

  return (
    <div className="max-w-7xl mx-auto">
      <div className="px-6 pt-6 flex items-center justify-between">
        <Link to="/clients" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700">
          <ChevronLeft size={16} /> All clients
        </Link>
        <div className="text-xs text-zinc-400 font-mono">session: {session.id.slice(0, 8)}</div>
      </div>

      <div className="px-6 pt-4 pb-2">
        <h1 className="text-2xl font-semibold text-zinc-900">{session.business_name_draft || 'New client onboarding'}</h1>
        <p className="text-sm text-zinc-500 mt-1">Vertical: <span className="capitalize">{session.vertical_draft || '—'}</span></p>
      </div>

      <Stepper steps={STEPS} currentIndex={safeIndex} session={session} />

      <div className="px-6 py-4">
        {session.status === 'sources'    && <StepSources session={session} onProgress={() => navigate(0)} />}
        {session.status === 'extracting' && <StepExtracting session={session} onComplete={() => navigate(0)} />}
        {session.status === 'review'     && <StepReview session={session} onAdvance={() => navigate(0)} />}
        {session.status === 'specialist' && <StepSpecialist session={session} onAdvance={() => navigate(0)} />}
        {(session.status === 'preview' || session.status === 'launching' || session.status === 'launched') && <StepLaunch session={session} />}
        {session.status === 'aborted'    && <AbortedNotice session={session} />}
      </div>
    </div>
  )
}

// ─── New session entry form ───────────────────────────────────────
function NewSessionForm({ onCreate, error }) {
  const [name, setName] = useState('')
  const [vertical, setVertical] = useState('roofing')

  return (
    <div className="max-w-2xl mx-auto p-6">
      <Link to="/clients" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700 mb-4">
        <ChevronLeft size={16} /> All clients
      </Link>

      <h1 className="text-2xl font-semibold text-zinc-900 mb-1">Start a new client</h1>
      <p className="text-sm text-zinc-500 mb-6">
        The wizard ingests the sales call, the discovery call, GHL data, and any
        existing online presence the prospect has. It produces a complete client
        profile across 18 sections, lets specialists tweak it, then provisions
        the site, Slack channels, phone number, and tracking infrastructure in
        one shot.
      </p>

      <div className="bg-white border border-zinc-200 rounded-lg p-6 space-y-4">
        <div>
          <label className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">Business name</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Austin Area Roofers"
            className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
          />
        </div>
        <div>
          <label className="block text-xs uppercase tracking-wide text-zinc-500 mb-1">Vertical</label>
          <select
            value={vertical}
            onChange={e => setVertical(e.target.value)}
            className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
          >
            <option value="roofing">Roofing</option>
            <option value="hvac">HVAC</option>
            <option value="plumbing">Plumbing</option>
            <option value="landscaping">Landscaping</option>
            <option value="dental">Dental</option>
            <option value="legal">Legal</option>
            <option value="restoration">Restoration</option>
            <option value="other">Other</option>
          </select>
        </div>

        {error && <div className="text-sm text-rose-700">{error}</div>}

        <button
          onClick={() => name && onCreate({ business_name_draft: name, vertical_draft: vertical })}
          disabled={!name}
          className="w-full px-4 py-2.5 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50"
        >
          Start wizard
        </button>
      </div>

      <div className="mt-6 text-xs text-zinc-400">
        v1 of the onboarding pipeline. Multi-step, resumable, audited end-to-end. Specialists can add suggestions before launch.
      </div>
    </div>
  )
}

// ─── Stepper ──────────────────────────────────────────────────────
function Stepper({ steps, currentIndex, session }) {
  return (
    <div className="border-y border-zinc-200 bg-zinc-50">
      <ol className="flex max-w-7xl mx-auto px-6 py-3 gap-2">
        {steps.map((step, i) => {
          const Icon = step.icon
          const isComplete = i < currentIndex
          const isCurrent = i === currentIndex
          return (
            <li key={step.key} className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
              isCurrent ? 'bg-emerald-50 text-emerald-800 font-medium border border-emerald-200' :
              isComplete ? 'text-emerald-700' :
              'text-zinc-400'
            }`}>
              {isComplete ? <Check size={16} /> : <Icon size={16} />}
              <span>{step.label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ─── Step 1: Sources ──────────────────────────────────────────────
function StepSources({ session, onProgress }) {
  const [sources, setSources] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(null)
  const [pasted, setPasted] = useState({ type: 'fathom_transcript', ref: '', body: '' })

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('onboarding_sources').select('*').eq('session_id', session.id).order('fetched_at', { ascending: false })
    setSources(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [session.id])

  async function addSource() {
    if (!pasted.body || !pasted.type) return
    setAdding(true)
    const { error } = await supabase.from('onboarding_sources').insert({
      session_id: session.id,
      source_type: pasted.type,
      source_ref: pasted.ref || null,
      raw_content: { text: pasted.body },
      parsed_summary: pasted.body.slice(0, 200),
      byte_size: pasted.body.length,
      status: 'fetched',
      fetched_by: 'operator',
    })
    if (error) alert(error.message)
    setPasted({ type: 'fathom_transcript', ref: '', body: '' })
    setAdding(false)
    await load()
  }

  async function runExtraction() {
    if (sources.length === 0) { alert('Add at least one source first.'); return }
    const { error: setStatusErr } = await supabase.from('onboarding_sessions')
      .update({ status: 'extracting', last_active_at: new Date().toISOString() })
      .eq('id', session.id)
    if (setStatusErr) { alert(setStatusErr.message); return }
    // Fire the edge function (don't await — it can take 30-60s; the StepExtracting screen polls for completion)
    fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ session_id: session.id }),
    }).catch(err => console.error('extract trigger failed', err))
    onProgress()
  }

  if (loading) return <Loader className="animate-spin text-zinc-400 mt-6" />

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <div className="bg-white border border-zinc-200 rounded-lg p-4">
          <h3 className="font-semibold text-zinc-900 mb-3">Add a source</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <select value={pasted.type} onChange={e => setPasted(p => ({ ...p, type: e.target.value }))}
              className="px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700">
              <option value="fathom_transcript">Fathom transcript</option>
              <option value="ghl_contact">GHL contact</option>
              <option value="site_crawl">Existing website</option>
              <option value="gbp_profile">Google Business Profile</option>
              <option value="bbb_profile">BBB profile</option>
              <option value="linkedin_company">LinkedIn company</option>
              <option value="manual_paste">Manual paste / notes</option>
            </select>
            <input
              type="text"
              value={pasted.ref}
              onChange={e => setPasted(p => ({ ...p, ref: e.target.value }))}
              placeholder="URL or reference (optional)"
              className="md:col-span-2 px-3 py-2 border border-zinc-200 rounded-md text-sm focus:outline-none focus:border-emerald-700"
            />
          </div>
          <textarea
            value={pasted.body}
            onChange={e => setPasted(p => ({ ...p, body: e.target.value }))}
            placeholder="Paste transcript, contact JSON, page HTML, or notes here. The wizard supports plain text."
            rows={8}
            className="w-full px-3 py-2 border border-zinc-200 rounded-md text-sm font-mono focus:outline-none focus:border-emerald-700"
          />
          <div className="mt-3 flex items-center gap-3">
            <button disabled={!pasted.body || adding} onClick={addSource}
              className="px-3 py-1.5 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50">
              Add source
            </button>
            <span className="text-xs text-zinc-400">Next-session features: auto-fetch by Fathom ID, GHL contact ID lookup, full site crawl.</span>
          </div>
        </div>

        <div className="bg-white border border-zinc-200 rounded-lg">
          <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between">
            <h3 className="font-semibold text-zinc-900">Ingested sources ({sources.length})</h3>
          </div>
          {sources.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-400 text-center">No sources yet. Add a Fathom transcript or paste your notes above.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {sources.map(s => (
                <li key={s.id} className="px-4 py-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium text-sm text-zinc-900">{s.source_type.replace(/_/g, ' ')}</div>
                      {s.source_ref && <div className="text-xs text-zinc-500 mt-0.5">{s.source_ref}</div>}
                      {s.parsed_summary && <div className="text-xs text-zinc-600 mt-1 line-clamp-2">{s.parsed_summary}…</div>}
                    </div>
                    <div className="text-xs text-zinc-400">{s.byte_size?.toLocaleString()} bytes</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
          <h3 className="font-semibold text-emerald-900 mb-2">Ready to extract?</h3>
          <p className="text-sm text-emerald-800 mb-4">
            When you've added every available source, the extraction agent will produce
            a complete 18-section profile via Anthropic. Takes 30-60 seconds.
          </p>
          <button
            onClick={runExtraction}
            disabled={sources.length === 0}
            className="w-full px-3 py-2 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50"
          >
            Run extraction <ChevronRight size={14} className="inline-block ml-1" />
          </button>
        </div>
        <div className="bg-white border border-zinc-200 rounded-lg p-4 text-xs text-zinc-500 space-y-2">
          <div className="font-semibold text-zinc-700 text-sm mb-1">Tips for an elite extraction</div>
          <div>• Use the FULL sales-call transcript, not just notes. Specific quotes become headlines.</div>
          <div>• Include the prospect's existing site URL — the crawl mines voice, services, areas.</div>
          <div>• Paste their GBP listing (categories, services, photos count, post cadence).</div>
          <div>• If they sent you a brand kit / pitch deck, paste that too.</div>
        </div>
      </div>
    </div>
  )
}

// ─── Step 2: Extracting (polling) ─────────────────────────────────
function StepExtracting({ session, onComplete }) {
  const [artifactCount, setArtifactCount] = useState(0)

  useEffect(() => {
    const interval = setInterval(async () => {
      const [{ count }, sessRes] = await Promise.all([
        supabase.from('onboarding_artifacts').select('id', { count: 'exact', head: true }).eq('session_id', session.id),
        supabase.from('onboarding_sessions').select('status').eq('id', session.id).single(),
      ])
      setArtifactCount(count || 0)
      if (sessRes.data?.status === 'review') {
        onComplete()
        clearInterval(interval)
      }
    }, 2500)
    return () => clearInterval(interval)
  }, [session.id])

  return (
    <div className="max-w-xl mx-auto py-12 text-center">
      <Sparkles size={32} className="mx-auto mb-3 text-emerald-700" />
      <h2 className="text-xl font-semibold text-zinc-900 mb-1">Extracting client profile</h2>
      <p className="text-sm text-zinc-500 mb-6">
        Anthropic is reading every source you provided and assembling the 18-section
        client profile. This typically takes 30-60 seconds.
      </p>
      <div className="bg-white border border-zinc-200 rounded-lg p-4 inline-block">
        <div className="text-3xl font-bold text-emerald-700">{artifactCount}<span className="text-zinc-400">/18</span></div>
        <div className="text-xs text-zinc-500 mt-1">sections landed so far</div>
      </div>
      <p className="mt-6 text-xs text-zinc-400">You can close this tab; the wizard is resumable from /clients/new/{session.id.slice(0, 8)}.</p>
    </div>
  )
}

// ─── Step 3: Review ───────────────────────────────────────────────
function StepReview({ session, onAdvance }) {
  const [artifacts, setArtifacts] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [activeSection, setActiveSection] = useState(null)

  async function load() {
    const [aRes, sRes] = await Promise.all([
      supabase.from('onboarding_artifacts').select('*').eq('session_id', session.id).order('section_key'),
      supabase.from('onboarding_suggestions').select('*').eq('session_id', session.id).is('dismissed_at', null),
    ])
    setArtifacts(aRes.data || [])
    setSuggestions(sRes.data || [])
    if (!activeSection && aRes.data?.length) setActiveSection(aRes.data[0].section_key)
  }
  useEffect(() => { load() }, [session.id])

  async function approve(id) {
    await supabase.from('onboarding_artifacts').update({ approved_by: 'operator', approved_at: new Date().toISOString() }).eq('id', id)
    await load()
  }

  async function advance() {
    await supabase.from('onboarding_sessions').update({ status: 'specialist', last_active_at: new Date().toISOString() }).eq('id', session.id)
    onAdvance()
  }

  const active = artifacts.find(a => a.section_key === activeSection)
  const sectionSuggestions = suggestions.filter(s => !s.section_key || s.section_key === activeSection)
  const approvedCount = artifacts.filter(a => a.approved_at).length

  return (
    <div className="grid grid-cols-12 gap-4">
      <aside className="col-span-3 bg-white border border-zinc-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-zinc-50 border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500">18 sections</div>
        <ul className="divide-y divide-zinc-100 max-h-[600px] overflow-y-auto">
          {artifacts.map(a => (
            <li key={a.id}>
              <button
                onClick={() => setActiveSection(a.section_key)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between ${activeSection === a.section_key ? 'bg-emerald-50 text-emerald-800' : 'hover:bg-zinc-50'}`}
              >
                <span>{a.section_key.replace(/_/g, ' ')}</span>
                <span className="flex items-center gap-1.5">
                  {a.confidence != null && <ConfidenceDot value={a.confidence} />}
                  {a.approved_at && <Check size={12} className="text-emerald-700" />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="col-span-6 bg-white border border-zinc-200 rounded-lg p-4 min-h-[600px]">
        {active ? (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-zinc-900">{active.section_key.replace(/_/g, ' ')}</h3>
              <div className="flex items-center gap-2 text-xs">
                {active.confidence != null && <span className="text-zinc-500">Confidence {(active.confidence * 100).toFixed(0)}%</span>}
                {active.inferred && <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded">inferred</span>}
              </div>
            </div>
            <pre className="text-xs bg-zinc-50 p-3 rounded border border-zinc-100 whitespace-pre-wrap overflow-x-auto max-h-[420px]">{JSON.stringify(active.data, null, 2)}</pre>
            <div className="mt-3 flex items-center gap-2">
              {!active.approved_at && (
                <button onClick={() => approve(active.id)}
                  className="px-3 py-1.5 bg-emerald-700 text-white rounded text-sm font-medium hover:bg-emerald-800">
                  Approve section
                </button>
              )}
              {active.approved_at && <span className="text-xs text-emerald-700">Approved · {new Date(active.approved_at).toLocaleTimeString()}</span>}
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">Select a section on the left.</p>
        )}
      </main>

      <aside className="col-span-3 space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <h4 className="font-semibold text-amber-900 text-sm mb-1">Specialist suggestions ({sectionSuggestions.length})</h4>
          {sectionSuggestions.length === 0 && <p className="text-xs text-amber-700">No suggestions yet for this section.</p>}
          <ul className="space-y-2 mt-2">
            {sectionSuggestions.slice(0, 5).map(s => (
              <li key={s.id} className="text-xs">
                <div className="font-medium text-amber-900">{s.title}</div>
                <div className="text-amber-700 mt-0.5">{s.body}</div>
                <div className="text-amber-500 mt-0.5 capitalize">{s.specialist_role} · {s.suggestion_type}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="bg-white border border-zinc-200 rounded-lg p-3">
          <div className="text-xs text-zinc-500">Approval progress</div>
          <div className="text-lg font-semibold text-zinc-900">{approvedCount}/{artifacts.length}</div>
          <button onClick={advance} disabled={approvedCount < artifacts.length}
            className="mt-3 w-full px-3 py-2 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50">
            Advance to specialists →
          </button>
        </div>
      </aside>
    </div>
  )
}

function ConfidenceDot({ value }) {
  const color = value >= 0.8 ? 'bg-emerald-500' : value >= 0.6 ? 'bg-amber-500' : 'bg-rose-500'
  return <span className={`w-2 h-2 rounded-full ${color}`} title={`${(value * 100).toFixed(0)}%`} />
}

// ─── Step 4: Specialist ───────────────────────────────────────────
function StepSpecialist({ session, onAdvance }) {
  const [suggestions, setSuggestions] = useState([])
  const [drafting, setDrafting] = useState(false)
  const [draft, setDraft] = useState({ specialist_role: 'seo', suggestion_type: 'addition', title: '', body: '', section_key: '' })

  async function load() {
    const { data } = await supabase.from('onboarding_suggestions').select('*').eq('session_id', session.id).order('created_at', { ascending: false })
    setSuggestions(data || [])
  }
  useEffect(() => { load() }, [session.id])

  async function addSuggestion() {
    if (!draft.title) return
    setDrafting(true)
    await supabase.from('onboarding_suggestions').insert({
      session_id: session.id,
      specialist_role: draft.specialist_role,
      specialist_user: 'operator',
      suggestion_type: draft.suggestion_type,
      title: draft.title,
      body: draft.body,
      section_key: draft.section_key || null,
    })
    setDraft({ specialist_role: 'seo', suggestion_type: 'addition', title: '', body: '', section_key: '' })
    setDrafting(false)
    await load()
  }

  async function applySuggestion(id) {
    await supabase.from('onboarding_suggestions').update({ applied: true, applied_at: new Date().toISOString(), applied_by: 'operator' }).eq('id', id)
    await load()
  }
  async function dismissSuggestion(id) {
    await supabase.from('onboarding_suggestions').update({ dismissed_at: new Date().toISOString(), dismissed_reason: 'manually dismissed' }).eq('id', id)
    await load()
  }

  async function advance() {
    await supabase.from('onboarding_sessions').update({ status: 'preview', last_active_at: new Date().toISOString() }).eq('id', session.id)
    onAdvance()
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-3">
        <h3 className="font-semibold text-zinc-900">Specialist suggestions ({suggestions.length})</h3>
        {suggestions.length === 0 && <p className="text-sm text-zinc-400">No suggestions yet. Specialists from SEO, Content, GBP, Compliance and AM teams can add suggestions before launch.</p>}
        {suggestions.map(s => (
          <div key={s.id} className={`bg-white border rounded-lg p-3 ${s.dismissed_at ? 'opacity-40 border-zinc-200' : s.applied ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-semibold">{s.title}</div>
                <div className="text-sm text-zinc-700 mt-1">{s.body}</div>
                <div className="text-xs text-zinc-500 mt-1.5 capitalize">{s.specialist_role} · {s.suggestion_type}{s.section_key ? ` · ${s.section_key.replace(/_/g, ' ')}` : ''}</div>
              </div>
              {!s.applied && !s.dismissed_at && (
                <div className="flex items-center gap-1.5">
                  <button onClick={() => applySuggestion(s.id)} className="text-xs px-2 py-1 bg-emerald-700 text-white rounded">Apply</button>
                  <button onClick={() => dismissSuggestion(s.id)} className="text-xs px-2 py-1 border border-zinc-200 rounded text-zinc-600">Dismiss</button>
                </div>
              )}
              {s.applied && <span className="text-xs text-emerald-700 flex items-center gap-1"><Check size={12} /> applied</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="bg-white border border-zinc-200 rounded-lg p-3">
          <h4 className="font-semibold text-zinc-900 text-sm mb-2">Add a suggestion</h4>
          <div className="space-y-2">
            <select value={draft.specialist_role} onChange={e => setDraft(d => ({ ...d, specialist_role: e.target.value }))}
              className="w-full px-2 py-1.5 border border-zinc-200 rounded text-sm">
              {['seo','content','gbp','compliance','citations','am','closer','founder','technical','other'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={draft.suggestion_type} onChange={e => setDraft(d => ({ ...d, suggestion_type: e.target.value }))}
              className="w-full px-2 py-1.5 border border-zinc-200 rounded text-sm">
              <option value="note">Note</option>
              <option value="override">Override</option>
              <option value="addition">Addition</option>
              <option value="flag">Flag</option>
              <option value="blocker">Blocker (gates launch)</option>
            </select>
            <input type="text" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
              placeholder="Short title"
              className="w-full px-2 py-1.5 border border-zinc-200 rounded text-sm" />
            <textarea value={draft.body} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
              rows={3} placeholder="Why + what to change"
              className="w-full px-2 py-1.5 border border-zinc-200 rounded text-sm" />
            <button onClick={addSuggestion} disabled={!draft.title || drafting}
              className="w-full px-3 py-1.5 bg-emerald-700 text-white rounded text-sm disabled:opacity-50">
              Add suggestion
            </button>
          </div>
        </div>

        <button onClick={advance}
          className="w-full px-3 py-2 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800">
          Lock specialist phase, go to preview →
        </button>
      </div>
    </div>
  )
}

// ─── Step 5: Launch ───────────────────────────────────────────────
function StepLaunch({ session }) {
  const [steps, setSteps] = useState([])
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState(null)

  async function loadSteps() {
    const { data } = await supabase
      .from('onboarding_provisioning_steps')
      .select('*').eq('session_id', session.id).order('started_at', { ascending: true, nullsFirst: false })
    setSteps(data || [])
  }
  useEffect(() => { loadSteps() }, [session.id])
  // Live poll while launching
  useEffect(() => {
    if (!launching && session.status !== 'launching') return
    const interval = setInterval(loadSteps, 1500)
    return () => clearInterval(interval)
  }, [launching, session.status])

  async function fireProvision() {
    setLaunching(true); setError(null)
    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ session_id: session.id }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'provision failed')
      await loadSteps()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setLaunching(false)
    }
  }

  const isLaunched = session.status === 'launched'

  const stepLabels = {
    create_client_row: 'Create client record',
    create_stakeholder_rows: 'Save stakeholder map',
    create_slack_channel_client: 'Create #client channel',
    create_slack_channel_internal: 'Create #client-internal channel',
    materialize_onboarding_touchpoints: 'Schedule 14-day touchpoint cadence',
    send_welcome_email: 'Send welcome email',
    create_ghl_opportunity: 'GHL opportunity (v2)',
    provision_quo_number: 'Quo phone number (v2)',
    create_drive_folder: 'Google Drive folder (v2)',
    create_github_repo: 'GitHub site repo (v2)',
    create_cloudflare_pages_project: 'Cloudflare Pages project (v2)',
    queue_brightlocal_citations: 'BrightLocal citations queue (v2)',
    create_results_portal_account: 'Results portal account (v2)',
    send_questionnaire: 'Onboarding questionnaire (v2)',
    fire_kickoff_event: 'Kickoff event (v2)',
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 bg-white border border-zinc-200 rounded-lg p-5">
        <div className="flex items-start gap-3 mb-5">
          <Rocket size={22} className="text-emerald-700 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-semibold text-zinc-900">{isLaunched ? 'Launched' : 'Launch'}</h3>
            <p className="text-sm text-zinc-500 mt-0.5">
              {isLaunched
                ? 'This client is provisioned. Open the client record to start operating.'
                : 'Fires the provisioning chain: creates the client record, stakeholders, Slack channels, and schedules the 14-day onboarding cadence. Deferred v2 steps (GHL, Quo, Cloudflare, GitHub, BrightLocal, Resend) are marked as skipped until wired.'}
            </p>
          </div>
        </div>

        {error && <div className="mb-3 p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-700">{error}</div>}

        <ol className="space-y-2">
          {Object.entries(stepLabels).map(([key, label]) => {
            const step = steps.find(s => s.step_key === key)
            const status = step?.status || 'pending'
            const icon = {
              pending:   <CircleDashed key="p" size={16} className="text-zinc-300" />,
              running:   <Loader key="r" size={16} className="text-amber-500 animate-spin" />,
              succeeded: <Check key="s" size={16} className="text-emerald-700" />,
              failed:    <AlertCircle key="f" size={16} className="text-rose-600" />,
              skipped:   <CircleDashed key="k" size={16} className="text-zinc-300" />,
            }[status]
            return (
              <li key={key} className="flex items-center gap-3 text-sm">
                {icon}
                <span className={status === 'skipped' ? 'text-zinc-400' : status === 'succeeded' ? 'text-zinc-900' : 'text-zinc-700'}>
                  {label}
                </span>
                {step?.output?.count != null && <span className="text-xs text-zinc-500">({step.output.count} items)</span>}
                {step?.error && <span className="text-xs text-rose-600 ml-auto">{step.error.slice(0, 50)}</span>}
              </li>
            )
          })}
        </ol>
      </div>

      <div className="space-y-3">
        {!isLaunched && (
          <button onClick={fireProvision} disabled={launching}
            className="w-full px-4 py-2.5 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 disabled:opacity-50">
            {launching ? 'Provisioning...' : 'Launch this client →'}
          </button>
        )}
        {isLaunched && (
          <Link to={`/clients/${steps.find(s => s.step_key === 'create_client_row')?.output?.slug}`}
            className="block w-full px-4 py-2.5 bg-emerald-700 text-white rounded-md text-sm font-medium hover:bg-emerald-800 text-center">
            Open client record →
          </Link>
        )}
        <div className="bg-zinc-50 border border-zinc-200 rounded-lg p-3 text-xs text-zinc-600 space-y-1.5">
          <div className="font-semibold text-zinc-900 text-sm mb-1">What launching does</div>
          <div>• Inserts the client into <code className="bg-white px-1">clients</code> with extraction data</div>
          <div>• Inserts every stakeholder into <code className="bg-white px-1">client_stakeholders</code></div>
          <div>• Creates 2 Slack channels (public + private)</div>
          <div>• Schedules 21 onboarding touchpoints across days 0-14</div>
          <div>• Marks the session as launched, client as active</div>
        </div>
      </div>
    </div>
  )
}

function AbortedNotice({ session }) {
  return (
    <div className="bg-rose-50 border border-rose-200 rounded-lg p-6">
      <h3 className="font-semibold text-rose-900">Session aborted</h3>
      <p className="text-sm text-rose-700 mt-1">{session.abort_reason || 'No reason recorded.'}</p>
      <Link to="/clients/new" className="mt-3 inline-block text-sm text-rose-700 underline">Start a fresh session →</Link>
    </div>
  )
}
