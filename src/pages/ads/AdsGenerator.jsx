import { useEffect, useState, useMemo, useRef } from 'react'
import { Sparkles, Copy, AlertCircle, FileText, ChevronDown, ChevronUp, Check, Zap, Layers, Plus, Settings, Trash2, X, Edit3 } from 'lucide-react'
import { generateScripts, generateAngles, generateProofsForAngle,
         listAngles, listHookShapes, listMechanisms,
         listProofCharactersForAngle,
         listGeneratedScripts,
         angleTypeMeta } from '../../services/scriptGenerator'
import { listOffers, getAttributeVocab } from '../../services/creativeTagger'
import { listTestBatches, addScriptsToBatch } from '../../services/testBatches'
import OfferConfigModal from '../../components/ads/OfferConfigModal'
import MechanismConfigModal from '../../components/ads/MechanismConfigModal'
import ProofCharacterEditor from '../../components/ads/ProofCharacterEditor'
import AngleEditorModal from '../../components/ads/AngleEditorModal'
import ConfirmModal from '../../components/ConfirmModal'
import { supabase } from '../../lib/supabase'
import { SectionHead, Eyebrow } from '../../components/editorial/atoms'

/*
  Script generator — rebuilt UX:
    - Big offer pills (not a dropdown)
    - "Diverse batch" mode is the default (no filters, max variance across attributes)
    - Optional "Targeted" mode reveals multi-select attribute chips
    - 1-30 concepts via slider with visual markers
    - Result cards with attribute pills + serif body + copy buttons
    - History table at bottom
*/

const FILTERABLE_ATTRS = [
  { key: 'hook_type',        label: 'Hook type' },
  { key: 'message_frame',    label: 'Message frame' },
  { key: 'mechanism_reveal', label: 'Mechanism reveal' },
  { key: 'pain_angle',       label: 'Pain angle' },
  { key: 'funnel_stage',     label: 'Funnel stage' },
  { key: 'awareness_level',  label: 'Awareness level' },
  { key: 'length_bucket',    label: 'Length bucket' },
]

export default function AdsGenerator() {
  const [offers, setOffers] = useState([])
  const [vocab, setVocab] = useState(null)
  const [offerSlug, setOfferSlug] = useState('')
  // Mode mix (Ben 2026-06-01, revised after "I can't find the option,
  // and I want to control how many of each I get"). Three Schwartz-aligned
  // modes; the batch is split across them per (angle × script-type):
  //   direct      = Stage 1-2 claim-led — classic OPT shape, warm traffic.
  //   hybrid      = Stage 2-3 claim + one mechanism-reveal — slightly cold.
  //   educational = Stage 3-4 mechanism-led — saturated markets, cold/TOFU,
  //                 where every claim has been heard and ONLY a new
  //                 mechanism reframes the promise.
  // Default = 10 Direct, 0 Hybrid, 0 Educational (matches prior behavior).
  // Total = sum of all three; if a mode is 0 it gets skipped entirely.
  const [modeQuotas, setModeQuotas] = useState({ direct: 10, hybrid: 0, educational: 0 })
  // "Use mechanism" toggle (Ben 2026-06-01 PM — "some scripts are
  // generating with the offer's mechanism name and some aren't. I want
  // to be able to select whether we are using the mechanism or not.")
  // Default ON to preserve existing behavior. When OFF, the edge fn
  // strips mechanism_short / mechanism_long / brand mechanism name
  // from the angle context so the script generates without the
  // brand-name mechanism reveal — useful when running Educational
  // mode or A/B-testing whether the brand-name lift is worth it.
  const [useMechanism, setUseMechanism] = useState(true)
  const nConcepts = (modeQuotas.direct || 0) + (modeQuotas.hybrid || 0) + (modeQuotas.educational || 0) + (modeQuotas.rom || 0)
  // Convenience: when only one mode is set, this is "the" mode (used in
  // history filtering, button labels, etc.). When 2+ modes are set,
  // scriptMode = 'mixed'.
  const activeModes = ['direct', 'hybrid', 'educational', 'rom'].filter(m => (modeQuotas[m] || 0) > 0)
  // eslint-disable-next-line no-unused-vars
  const scriptMode = activeModes.length === 1 ? activeModes[0] : 'mixed'
  // Noop shim — the legacy `generatorMode === 'attributes'` UI (dead since
  // the 2026-05-31 simplification) still references setNConcepts directly.
  // Rather than delete ~400 lines of dead JSX, keep the shim so build passes.
  // eslint-disable-next-line no-unused-vars
  const setNConcepts = () => {}
  const [mode, setMode] = useState('diverse')
  const [targets, setTargets] = useState({})
  const [saveAsDrafts, setSaveAsDrafts] = useState(true)
  // Optional: save the freshly-generated scripts into a draft test batch.
  // null = loose drafts (no batch); else a batch.id from listTestBatches().
  const [saveToBatchId, setSaveToBatchId] = useState(null)
  const [draftBatches, setDraftBatches] = useState([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [offerModalOpen, setOfferModalOpen] = useState(false)
  const [offerModalExisting, setOfferModalExisting] = useState(null)

  // 2026-05-31 overhaul: top-level toggle is now Scripts vs Messaging.
  // Scripts = the existing hook/body/joined template generator.
  // Messaging = generate angles (problems + desires) for an offer, auto-
  // saved to the angle library so they immediately appear in the
  // Scripts > Angle picker. The legacy 8-attribute generator is no
  // longer surfaced in the UI — the Edge Function still supports it for
  // any external callers, but new users only see the Scripts/Messaging
  // tiles.
  const [genTarget, setGenTarget] = useState('scripts')   // 'scripts' | 'messaging'
  // Messaging-mode state
  const [nicheHint, setNicheHint] = useState('')
  const [nProblems, setNProblems] = useState(5)
  const [nCircumstances, setNCircumstances] = useState(3)
  const [nOutcomes, setNOutcomes] = useState(5)
  const [messagingBusy, setMessagingBusy] = useState(false)
  const [messagingResult, setMessagingResult] = useState(null)
  // Free-text extra instructions appended to the Claude prompt. Used for
  // both modes — operator can name specific proofs ("lead with Eric's
  // $215K case study"), banned phrases, framing tweaks, etc.
  const [extraInstructions, setExtraInstructions] = useState('')
  // Per-angle proof character roster + which subset to feature this batch.
  // Reloaded whenever the angle changes. Empty selectedProofNames = use ALL
  // active proofs for the angle (the Edge Function's default behavior).
  const [proofCharacters, setProofCharacters] = useState([])
  const [selectedProofNames, setSelectedProofNames] = useState([])
  // Proof editor target: the angle being edited. Decoupled from
  // primaryAngleSlug so the gear icon on each chip can open the editor
  // for ANY angle regardless of selection state (Ben 2026-06-01).
  // null = closed.
  const [proofEditorAngle, setProofEditorAngle] = useState(null)
  // Angle editor — { mode: 'edit'|'create', angle: rowOrNull }. Opens the
  // modal that lets the operator fix wording (qualifier / name / mechanism)
  // on existing rows OR seed a brand-new custom angle when no generated
  // angle fits the scenario they want to test.
  const [angleEditorTarget, setAngleEditorTarget] = useState(null)
  // Per-angle proof lists — full rows, not just counts. Lets the angle
  // chip indicator show "no proofs yet", the angle library tile show a
  // breakdown by proof_type, and the Scripts "pulling proofs from"
  // summary aggregate across multiple selected angles without re-fetching.
  // Map<slug, proof[]>.
  const [proofsByAngle, setProofsByAngle] = useState({})
  // History: previously generated scripts for the current offer (drafts).
  // Loaded per offer; refreshed after every successful Generate. Grouped
  // by minute-bucket in the UI so a single fan-out run shows as one row.
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)

  // Template-based generator (Ben 2026-05-31). Templates is now the
  // only path — Mode toggle was removed in the /generate overhaul.
  // generatorMode useState below is kept so handleGenerate keeps its
  // branch logic; in practice it's always 'templates' going forward.
  // eslint-disable-next-line no-unused-vars
  const [generatorMode, setGeneratorMode] = useState('templates')
  // Multi-select script types (Ben 2026-05-31): fan out per type so a single
  // batch can produce hooks AND bodies AND joined scripts. Empty array =
  // nothing selected (Generate disabled).
  const [scriptTypes, setScriptTypes] = useState(['hook'])
  // Multi-select angles (Ben 2026-05-31): pick 1-N angles, the fan-out runs
  // n_concepts per (angle × type) combo. When exactly one is selected the
  // preview + mechanism picker + proof picker behave as before; with more
  // than one those collapse to a note ("each angle uses its own defaults").
  const [angleSlugs, setAngleSlugs] = useState([])
  // Derived: the single "active" angle when exactly one is picked. Used by
  // the preview / mechanism / proof effects so they keep working with the
  // old single-select code paths.
  const primaryAngleSlug = angleSlugs.length === 1 ? angleSlugs[0] : ''
  const [mechanismSlug, setMechanismSlug] = useState('')      // optional (migration 108)
  const [targetShapes, setTargetShapes] = useState([])        // string[] of A-H codes; empty = all
  const [targetLength, setTargetLength] = useState('60_75s')
  const [angles, setAngles] = useState([])
  const [hookShapes, setHookShapes] = useState([])
  const [mechanisms, setMechanisms] = useState([])
  const [mechanismModalOpen, setMechanismModalOpen] = useState(false)
  const [mechanismModalExisting, setMechanismModalExisting] = useState(null)

  async function refreshOffers() {
    const o = await listOffers()
    setOffers(o)
    return o
  }

  useEffect(() => {
    Promise.all([listOffers(), getAttributeVocab()])
      .then(([o, v]) => {
        setOffers(o); setVocab(v)
        const live = o.find(x => !x.slug.includes('stub') && !x.slug.includes('template')) || o[0]
        if (live) setOfferSlug(live.slug)
      })
      .catch(e => setErr(e.message))
    // Pull just the draft batches for the save-to-batch dropdown
    listTestBatches({ launched: false })
      .then(setDraftBatches)
      .catch(() => setDraftBatches([]))
    // Template-mode catalog: hook shapes are global, mechanisms reload
    // per-angle below. Angles reload per-offer in the offer-change effect.
    Promise.all([
      listHookShapes().catch(() => []),
      listMechanisms().catch(() => []),
    ]).then(([hs, ms]) => {
      setHookShapes(hs)
      setMechanisms(ms)
    })
  }, [])

  // Refetch the angle library whenever the operator switches offers.
  // Angles tagged with offer_slug get filtered server-side via the
  // .includes-or-untagged convention in listAngles. If the previously
  // selected angle is no longer in the offer's list, reset the picker
  // to avoid silent "wrong-angle" generations.
  useEffect(() => {
    if (!offerSlug) { setAngles([]); setAngleSlugs([]); setProofsByAngle({}); return }
    let cancelled = false
    listAngles({ offer_slug: offerSlug })
      .then(async rows => {
        if (cancelled) return
        setAngles(rows)
        // Keep any selected angles that still belong to this offer; drop
        // ones that don't. If nothing remains, leave empty (no auto-pick —
        // forces explicit selection, which avoids accidental multi-runs).
        setAngleSlugs(prev => prev.filter(s => rows.some(r => r.slug === s)))
        // Fetch full proof rows per angle (parallel) so each chip can show
        // a "needs proofs" indicator AND the library tile can show a
        // type breakdown AND the Scripts proof-source preview can
        // aggregate across selected angles without re-fetching.
        const lists = await Promise.all(
          rows.map(r => listProofCharactersForAngle(r.slug).catch(() => []))
        )
        if (cancelled) return
        const map = {}
        rows.forEach((r, i) => { map[r.slug] = lists[i] })
        setProofsByAngle(map)
      })
      .catch(() => { if (!cancelled) { setAngles([]); setAngleSlugs([]); setProofsByAngle({}) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerSlug])

  // Refresh a single angle's proof list — called after the editor
  // saves so the chip indicator + tile breakdown update without a full
  // refetch of the whole library.
  async function refreshProofCount(slug) {
    if (!slug) return
    try {
      const rows = await listProofCharactersForAngle(slug)
      setProofsByAngle(prev => ({ ...prev, [slug]: rows }))
      // Also refresh the picker's local list if this is the primary angle
      if (slug === primaryAngleSlug) {
        setProofCharacters(rows)
        setSelectedProofNames(prev => prev.filter(n => rows.some(r => r.name === n)))
      }
    } catch {}
  }

  // Load history for the current offer. Called on offer change + after
  // every Generate. Fetches the last 50 drafts so a multi-batch run
  // (which inserts N rows) all surface in one place.
  async function refreshHistory(slug) {
    const target = slug || offerSlug
    if (!target) { setHistory([]); return }
    setHistoryLoading(true)
    try {
      const rows = await listGeneratedScripts({ offer_slug: target, limit: 200 })
      setHistory(rows)
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }
  useEffect(() => { refreshHistory(offerSlug) /* eslint-disable-next-line */ }, [offerSlug])

  // Refresh mechanism + proof lists whenever the single-selected angle changes.
  // Multi-angle mode hides those pickers — each angle uses its own defaults
  // server-side — so we only load them when exactly one is selected.
  // Filter by offer_slug too (Ben 2026-06-01) — otherwise an accounting-scoped
  // mechanism like "Banker + Attorney Referral Chain" leaks into the
  // restoration picker, which is irrelevant noise.
  useEffect(() => {
    if (!primaryAngleSlug) return
    listMechanisms({ offer_slug: offerSlug, angle_slug: primaryAngleSlug })
      .then(setMechanisms).catch(() => {})
  }, [primaryAngleSlug, offerSlug])

  useEffect(() => {
    if (!primaryAngleSlug) { setProofCharacters([]); setSelectedProofNames([]); return }
    let cancelled = false
    listProofCharactersForAngle(primaryAngleSlug)
      .then(rows => {
        if (cancelled) return
        setProofCharacters(rows)
        setSelectedProofNames([])   // reset subset on angle change
      })
      .catch(() => { if (!cancelled) { setProofCharacters([]); setSelectedProofNames([]) } })
    return () => { cancelled = true }
  }, [primaryAngleSlug])

  async function refreshProofCharacters() {
    if (!primaryAngleSlug) return
    try {
      const rows = await listProofCharactersForAngle(primaryAngleSlug)
      setProofCharacters(rows)
      setSelectedProofNames(prev => prev.filter(n => rows.some(r => r.name === n)))
    } catch {}
  }

  // Messaging tab: the full saved-angle library for the current offer.
  // Kept separate from `angles` (which is the Scripts picker source — same
  // data, but I want this reactive even when the user isn't on Scripts).
  // Dedup by case-insensitive name so DB-level dupes don't pollute the
  // UI (the Edge Function slug formula can produce dupes per regen).
  const [messagingLibrary, setMessagingLibrary] = useState([])
  const [messagingLibraryLoading, setMessagingLibraryLoading] = useState(false)

  async function refreshMessagingLibrary(slug) {
    const target = slug || offerSlug
    if (!target) { setMessagingLibrary([]); return }
    setMessagingLibraryLoading(true)
    try {
      const rows = await listAngles({ offer_slug: target })
      // Dedup by lowercased name, keep first occurrence (rows arrive
      // ordered by angle_type then name from the service).
      const seen = new Set()
      const deduped = []
      for (const r of rows) {
        const key = (r.name || '').trim().toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        deduped.push(r)
      }
      setMessagingLibrary(deduped)
    } catch {
      setMessagingLibrary([])
    } finally {
      setMessagingLibraryLoading(false)
    }
  }

  useEffect(() => { refreshMessagingLibrary(offerSlug) /* eslint-disable-next-line */ }, [offerSlug])

  function openNewMechanism() {
    setMechanismModalExisting(null)
    setMechanismModalOpen(true)
  }
  function openConfigureMechanism(m) {
    setMechanismModalExisting(m)
    setMechanismModalOpen(true)
  }
  async function handleMechanismSaved(saved) {
    setMechanismModalOpen(false)
    // primaryAngleSlug is the only meaningful angle when refreshing
    // mechanism compat; in multi-select mode skip the refresh (mechanism
    // picker isn't visible anyway).
    if (primaryAngleSlug) {
      const fresh = await listMechanisms({ offer_slug: offerSlug, angle_slug: primaryAngleSlug }).catch(() => [])
      setMechanisms(fresh)
    }
    if (saved?.slug) setMechanismSlug(saved.slug)
  }

  function openNewOffer() {
    setOfferModalExisting(null)
    setOfferModalOpen(true)
  }

  function openConfigureOffer(o) {
    setOfferModalExisting(o)
    setOfferModalOpen(true)
  }

  async function handleOfferSaved(saved) {
    setOfferModalOpen(false)
    const fresh = await refreshOffers()
    if (saved?.slug) {
      // Save or edit — select the saved offer.
      setOfferSlug(saved.slug)
    } else {
      // Retire — `saved` is null. If the currently selected offer was just
      // retired (no longer in the fresh list), fall back to the first live
      // offer so all the offer-derived state effects re-fire cleanly.
      if (!fresh.some(o => o.slug === offerSlug)) {
        const live = fresh.find(o => !o.slug.includes('stub') && !o.slug.includes('template')) || fresh[0]
        setOfferSlug(live?.slug || '')
      }
    }
  }

  function toggleTarget(field, value) {
    setTargets(prev => {
      const arr = prev[field] || []
      const next = arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]
      const cloned = { ...prev }
      if (next.length === 0) delete cloned[field]
      else cloned[field] = next
      return cloned
    })
  }

  async function handleGenerateMessaging() {
    if (!offerSlug) { setErr('Pick an offer first'); return }
    const total = nProblems + nCircumstances + nOutcomes
    if (total === 0) { setErr('Pick at least one bucket > 0'); return }
    setMessagingBusy(true); setErr(null); setMessagingResult(null)
    // Persist an in-flight marker so this run survives navigation —
    // if the operator clicks away mid-flight, the next mount sees this
    // marker and shows a recovery banner that polls the library until
    // the new rows appear or 5 min lapses.
    const baselineCount = messagingLibrary.length
    saveMessagingInFlight({
      offer_slug: offerSlug,
      started_at: Date.now(),
      expected_count: total,
      baseline_lib_count: baselineCount,
    })
    try {
      const res = await generateAngles({
        offer_slug: offerSlug,
        n_problems: nProblems,
        n_circumstances: nCircumstances,
        n_outcomes: nOutcomes,
        niche_hint: nicheHint || undefined,
        extra_instructions: extraInstructions.trim() || undefined,
      })
      setMessagingResult(res)
      if (res?.queued) {
        // Background job — Edge Function returns 202 immediately and
        // does the actual generation via EdgeRuntime.waitUntil. Kick
        // off polling directly (the offerSlug-effect won't re-fire
        // since the offer hasn't changed).
        startInFlightPolling({
          offer_slug: offerSlug,
          started_at: Date.now(),
          expected_count: total,
          baseline_lib_count: baselineCount,
        })
      } else {
        // Synchronous response (legacy / non-messaging path)
        listAngles({ offer_slug: offerSlug }).then(setAngles).catch(() => {})
        refreshMessagingLibrary(offerSlug)
        clearMessagingInFlight()
      }
    } catch (e) {
      setErr(e.message)
      clearMessagingInFlight()
    } finally {
      setMessagingBusy(false)
    }
  }

  // ── In-flight messaging job recovery (Ben 2026-06-01) ──────────
  // Three scenarios this needs to handle:
  //   1. Operator clicks Generate, navigates away, comes back later
  //      → mount-time effect reads localStorage, starts polling
  //   2. Operator clicks Generate and stays on page (current run via
  //      EdgeRuntime.waitUntil — Edge Function returned 202 immediately)
  //      → handleGenerateMessaging calls startInFlightPolling directly
  //   3. Operator clicks Generate, gen completes within seconds
  //      → polling detects new rows, clears marker, stops
  //
  // The polling itself is the same in all three cases — factor it out
  // so both entry points can kick it off.
  const [inFlightRecovery, setInFlightRecovery] = useState(null)
  const pollIntervalRef = useRef(null)

  function startInFlightPolling(job) {
    if (!job?.offer_slug) return
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
    setInFlightRecovery(job)
    pollIntervalRef.current = setInterval(async () => {
      try {
        const fresh = await listAngles({ offer_slug: job.offer_slug })
        if (fresh.length > job.baseline_lib_count) {
          setAngles(fresh)
          refreshMessagingLibrary(job.offer_slug)
          clearMessagingInFlight()
          setInFlightRecovery(null)
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
      } catch {}
      if ((Date.now() - job.started_at) / 1000 > 300) {
        clearMessagingInFlight()
        setInFlightRecovery(null)
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
      }
    }, 4000)
  }

  // Mount-time recovery — only fires when the offer changes (or first
  // mount). Handles scenario 1 (operator returns to page after closing
  // browser / navigating away).
  useEffect(() => {
    if (!offerSlug) return
    const job = readMessagingInFlight()
    if (!job || job.offer_slug !== offerSlug) return
    const ageSec = (Date.now() - job.started_at) / 1000
    if (ageSec > 300) { clearMessagingInFlight(); return }
    startInFlightPolling(job)
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offerSlug])

  // Two-stage confirm: clicking Retire on a row sets retireAngleTarget,
  // which opens the ConfirmModal. ConfirmModal's confirm fires performRetireAngle.
  const [retireAngleTarget, setRetireAngleTarget] = useState(null)  // { slug, name }
  const [retireAngleBusy, setRetireAngleBusy] = useState(false)

  async function performRetireAngle() {
    const target = retireAngleTarget
    if (!target?.slug) return
    setRetireAngleBusy(true)
    try {
      const { error } = await supabase.from('script_angles')
        .update({ active: false }).eq('slug', target.slug)
      if (error) throw new Error(error.message)
      setMessagingLibrary(prev => prev.filter(a => a.slug !== target.slug))
      setAngles(prev => prev.filter(a => a.slug !== target.slug))
      setAngleSlugs(prev => prev.filter(s => s !== target.slug))
      setRetireAngleTarget(null)
    } catch (e) {
      setErr(`Retire failed: ${e.message}`)
    } finally {
      setRetireAngleBusy(false)
    }
  }

  // Bulk selection for the library tiles. Ben asked for this so he can
  // mass-retire the duplicate clusters that pile up after a few 5+5+5 runs
  // (e.g. 6 Maps Top-3 variants, 5 AI Citation variants). Selection is a
  // Set of slugs so toggle is O(1). The "find similar" filter toggles a
  // simple normalize-name-and-group view so he can see clusters at a glance.
  const [selectedAngleSlugs, setSelectedAngleSlugs] = useState(() => new Set())
  const [bulkRetireOpen, setBulkRetireOpen] = useState(false)
  const [bulkRetireBusy, setBulkRetireBusy] = useState(false)
  const [findSimilar, setFindSimilar] = useState(false)

  function toggleSelectAngle(slug) {
    setSelectedAngleSlugs(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug); else next.add(slug)
      return next
    })
  }
  function clearAngleSelection() {
    setSelectedAngleSlugs(new Set())
  }
  function selectAllVisible(visibleSlugs) {
    setSelectedAngleSlugs(new Set(visibleSlugs))
  }

  async function performBulkRetire() {
    if (selectedAngleSlugs.size === 0) return
    setBulkRetireBusy(true)
    // Capture into a fresh Set so the filter callbacks below don't depend
    // on the live `selectedAngleSlugs` state (which gets cleared while
    // the await is in flight). Caught by code-review 2026-06-01.
    const slugs = Array.from(selectedAngleSlugs)
    const slugSet = new Set(slugs)
    try {
      const { error } = await supabase.from('script_angles')
        .update({ active: false }).in('slug', slugs)
      if (error) throw new Error(error.message)
      setMessagingLibrary(prev => prev.filter(a => !slugSet.has(a.slug)))
      setAngles(prev => prev.filter(a => !slugSet.has(a.slug)))
      setAngleSlugs(prev => prev.filter(s => !slugSet.has(s)))
      setSelectedAngleSlugs(new Set())
      setBulkRetireOpen(false)
    } catch (e) {
      setErr(`Bulk retire failed: ${e.message}`)
    } finally {
      setBulkRetireBusy(false)
    }
  }

  // Fan-out progress: how many sub-batches in flight + which combo each is on.
  // The Edge Function is one-shot per call, so for multi-angle/multi-type we
  // fire N parallel calls and aggregate. Progress is per-call so the operator
  // can see which combos completed first.
  const [fanProgress, setFanProgress] = useState({ total: 0, done: 0, failed: 0 })

  async function handleGenerate() {
    setErr(null); setResult(null)
    const extras = extraInstructions.trim() || undefined

    if (generatorMode !== 'templates') {
      // Legacy attribute mode: single offer, no fan-out.
      setGenerating(true)
      try {
        const res = await generateScripts({
          offer_slug: offerSlug,
          n_concepts: nConcepts,
          target_attributes: mode === 'targeted' ? targets : {},
          save_as_drafts: true,
          extra_instructions: extras,
        })
        setResult(res)
        if (res.save_error) setErr(`Generated but save-as-drafts failed: ${res.save_error}`)
      } catch (e) {
        setErr(e.message)
      } finally {
        setGenerating(false)
      }
      return
    }

    // Template mode: fan out one Edge Function call per (angle × type) combo.
    if (!angleSlugs.length) { setErr('Pick at least one angle'); return }
    if (!scriptTypes.length) { setErr('Pick at least one script type'); return }

    // Auto-generate proof characters for any selected angle that has none.
    // We check synchronously by counting active proofs per angle — fastest
    // path is to call listProofCharactersForAngle in parallel for each.
    // Ben's rule: "If there's no proof characters, it should generate them
    // by default." We do this BEFORE fan-out so the script generator has
    // proofs to use.
    setGenerating(true)
    try {
      const proofChecks = await Promise.all(
        angleSlugs.map(slug => listProofCharactersForAngle(slug).catch(() => []))
      )
      const anglesNeedingProofs = angleSlugs.filter((slug, i) => proofChecks[i].length === 0)
      if (anglesNeedingProofs.length) {
        setFanProgress({ total: anglesNeedingProofs.length, done: 0, failed: 0, phase: 'proofs' })
        await Promise.allSettled(
          anglesNeedingProofs.map(async (slug) => {
            try {
              await generateProofsForAngle({ angle_slug: slug, n: 4 })
              setFanProgress(p => ({ ...p, done: p.done + 1 }))
            } catch (e) {
              setFanProgress(p => ({ ...p, failed: p.failed + 1 }))
              console.warn(`auto-proofs for ${slug} failed: ${e.message}`)
            }
          })
        )
        // Refresh the local proof state for the primary angle if it was one
        // of the ones we just generated, so the picker shows the new entries.
        if (primaryAngleSlug && anglesNeedingProofs.includes(primaryAngleSlug)) {
          await refreshProofCharacters()
        }
      }

      // Fan out per (angle × script-type × mode). Only modes with quota > 0
      // get a batch. Each mode call uses its own n_concepts so the totals
      // hit the operator's exact mix.
      const combos = []
      for (const slug of angleSlugs) {
        for (const type of scriptTypes) {
          for (const mode of activeModes) {
            const n = modeQuotas[mode] || 0
            if (n <= 0) continue
            combos.push({ angle_slug: slug, script_type: type, script_mode: mode, n_concepts: n })
          }
        }
      }
      setFanProgress({ total: combos.length, done: 0, failed: 0, phase: 'scripts' })

      const settled = await Promise.allSettled(combos.map(async (c) => {
        const r = await generateScripts({
          script_type: c.script_type,
          angle_slug: c.angle_slug,
          mechanism_slug: angleSlugs.length === 1 ? (mechanismSlug || undefined) : undefined,
          target_shapes: targetShapes.length ? targetShapes : undefined,
          target_length: (c.script_type === 'body' || c.script_type === 'joined') ? targetLength : undefined,
          target_proof_characters: angleSlugs.length === 1 && selectedProofNames.length
            ? selectedProofNames : undefined,
          n_concepts: c.n_concepts,
          script_mode: c.script_mode,
          use_mechanism: useMechanism,
          save_as_drafts: true,
          extra_instructions: extras,
        })
        setFanProgress(p => ({ ...p, done: p.done + 1 }))
        return r
      }))

      // Aggregate scripts across all successful calls into a single result.
      // Failed calls get logged in setErr.
      const allScripts = []
      const failures = []
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          for (const s of (r.value?.scripts || [])) {
            allScripts.push({ ...s, _combo: combos[i] })
          }
        } else {
          failures.push(`${combos[i].angle_slug} (${combos[i].script_type}): ${r.reason?.message || r.reason}`)
        }
      })
      if (failures.length) {
        setErr(`${failures.length} of ${combos.length} batch${combos.length === 1 ? '' : 'es'} failed:\n${failures.join('\n')}`)
        setFanProgress(p => ({ ...p, failed: failures.length }))
      }
      // Mirror the existing result-panel shape so the UI doesn't change
      setResult({ scripts: allScripts, model: settled.find(r => r.status === 'fulfilled')?.value?.model || '' })
      // Refresh history so the new drafts surface in the History block.
      refreshHistory(offerSlug)
    } catch (e) {
      setErr(e.message)
    } finally {
      setGenerating(false)
    }
  }

  const selectedOffer = offers.find(o => o.slug === offerSlug)

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Generate"
        title="Generate"
        tagline="Pick an offer, choose a batch size, and either let the system maximize variance across attributes or target specific variables for an A/B test."
        gap={28}
      />

      {err && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fca5a5',
                      color: 'var(--down)', fontSize: 13, marginBottom: 20, borderRadius: 9 }}>
          <AlertCircle size={14} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />{err}
        </div>
      )}

      {/* Top-level: WHAT do you want to generate?
          Two routing-grade choices — Scripts (hook/body/joined from the
          angle library) vs Messaging (angles themselves — problems +
          desires — for an offer, auto-saved to the library). */}
      <div style={{ marginBottom: 28 }}>
        <Eyebrow style={{ marginBottom: 10 }}>What do you want to generate?</Eyebrow>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <ModeCard
            selected={genTarget === 'scripts'}
            onClick={() => setGenTarget('scripts')}
            icon={<Sparkles size={18} />}
            title="Scripts"
            desc="Generate hooks, bodies, or joined hook+body scripts from an angle in your library. Mechanism and proof attach at generation time."
          />
          <ModeCard
            selected={genTarget === 'messaging'}
            onClick={() => setGenTarget('messaging')}
            icon={<FileText size={18} />}
            title="Messaging"
            desc="Generate angles (problems + desires) for an offer in the prospect's voice. Auto-saved to your angle library so they appear in the Scripts picker."
          />
        </div>
      </div>

      {/* Offer selection — shared between both targets. Always visible. */}
      <Section label="01" title="Offer">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {offers.map(o => {
            const selected = o.slug === offerSlug
            const isStub = o.slug.includes('stub') || o.slug.includes('template')
            const incomplete = !o.mechanism_name || !o.primary_audience
            return (
              <div key={o.slug} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                <button
                  onClick={() => setOfferSlug(o.slug)}
                  style={{
                    padding: '10px 14px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderRight: selected ? '2px solid var(--ink)' : 'none',
                    background: selected ? 'var(--ink)' : 'var(--paper)',
                    color: selected ? 'var(--paper)' : isStub ? 'var(--ink-4)' : 'var(--ink)',
                    fontFamily: 'var(--sans)', fontSize: 14, fontWeight: selected ? 600 : 400,
                    cursor: 'pointer', borderRadius: '2px 0 0 2px',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    transition: 'all 140ms ease',
                  }}>
                  {selected && <Check size={14} />}
                  <span>{o.name}</span>
                  {incomplete && (
                    <span style={{ fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.1em',
                                  background: '#e0a93e', color: '#3b2a04', padding: '2px 5px',
                                  borderRadius: 9, textTransform: 'uppercase' }}>
                      needs config
                    </span>
                  )}
                </button>
                <button
                  onClick={() => openConfigureOffer(o)}
                  title="Configure offer"
                  style={{
                    padding: '10px 8px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderLeft: '1px solid var(--rule)',
                    background: selected ? 'var(--ink)' : 'var(--paper)',
                    color: selected ? 'var(--paper)' : 'var(--ink-3)',
                    cursor: 'pointer', borderRadius: '0 2px 2px 0',
                    display: 'inline-flex', alignItems: 'center',
                  }}>
                  <Settings size={14} />
                </button>
              </div>
            )
          })}
          <button onClick={openNewOffer}
            style={{
              padding: '10px 16px',
              border: '2px dashed var(--rule)', background: 'transparent',
              color: 'var(--ink-3)',
              fontFamily: 'var(--sans)', fontSize: 14,
              cursor: 'pointer', borderRadius: 9,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
            <Plus size={14} />
            New offer
          </button>
        </div>
      </Section>

      <OfferConfigModal
        open={offerModalOpen}
        existing={offerModalExisting}
        onClose={() => setOfferModalOpen(false)}
        onSaved={handleOfferSaved}
      />

      {/* ──── MESSAGING MODE ──── */}
      {genTarget === 'messaging' && (
        <>
          {/* Recovery banner: appears when an in-flight job was started
              for THIS offer in a previous session/tab and hasn't returned
              yet. Polls the library every 4s; clears itself when new rows
              appear or after 5 min. The user can dismiss it manually. */}
          {inFlightRecovery && inFlightRecovery.offer_slug === offerSlug && (
            <div style={{
              marginBottom: 12, padding: '12px 14px',
              background: '#fef6e6', border: '1px solid #e8c98a',
              borderLeft: '3px solid #d68f00',
              fontFamily: 'var(--sans)', fontSize: 13, color: '#7a5810',
              borderRadius: 9, display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: '#d68f00', animation: 'pulse 1s ease-in-out infinite',
                flexShrink: 0,
              }} />
              <div style={{ flex: 1, lineHeight: 1.5 }}>
                <strong>Generation in progress from an earlier session</strong>
                <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 11 }}>
                  ({Math.floor((Date.now() - inFlightRecovery.started_at) / 1000)}s ago · expecting {inFlightRecovery.expected_count} angles)
                </span>
                <div style={{ fontSize: 12, fontStyle: 'italic', marginTop: 2, color: '#8a6418' }}>
                  Polling the library for new rows. They'll appear below as soon as Claude finishes.
                </div>
              </div>
              <button onClick={() => { clearMessagingInFlight(); setInFlightRecovery(null) }}
                title="Dismiss"
                style={{
                  padding: 4, background: 'transparent', border: 'none',
                  color: '#8a6418', cursor: 'pointer',
                }}>
                <X size={14} />
              </button>
              <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
            </div>
          )}

          {/* Count + Generate row — primary action. */}
          <div style={{
            marginBottom: 6,
            padding: '16px 18px', background: 'var(--paper)',
            border: '1px solid var(--rule)', borderTop: '3px solid var(--ink)',
            borderRadius: 9,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
              {[
                { key: 'Problems',      value: nProblems,      set: setNProblems,      color: 'var(--down)' },
                { key: 'Circumstances', value: nCircumstances, set: setNCircumstances, color: '#d4a535' },
                { key: 'Outcomes',      value: nOutcomes,      set: setNOutcomes,      color: '#3068b5' },
              ].map(b => (
                <div key={b.key}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: 1,
                      background: b.color, display: 'inline-block',
                    }} />
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
                      textTransform: 'uppercase', color: 'var(--ink-4)',
                    }}>{b.key}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 3, 5, 10, 15, 20].map(n => (
                      <button key={n} onClick={() => b.set(n)}
                        style={{
                          padding: '8px 12px',
                          border: `1px solid ${b.value === n ? 'var(--ink)' : 'var(--rule)'}`,
                          background: b.value === n ? 'var(--accent)' : 'var(--paper)',
                          color: 'var(--ink)',
                          fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600,
                          cursor: 'pointer', borderRadius: 9, minWidth: 42,
                        }}>{n}</button>
                    ))}
                  </div>
                </div>
              ))}
              <button onClick={handleGenerateMessaging}
                disabled={messagingBusy || !offerSlug || (nProblems + nCircumstances + nOutcomes === 0)}
                style={{
                  marginLeft: 'auto',
                  padding: '14px 24px', fontFamily: 'var(--mono)', fontSize: 12,
                  letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700,
                  border: '2px solid var(--ink)',
                  background: messagingBusy ? 'var(--ink-3)' : 'var(--ink)',
                  color: 'var(--paper)', cursor: messagingBusy ? 'wait' : 'pointer',
                  opacity: (!offerSlug || (nProblems + nCircumstances + nOutcomes === 0)) ? 0.4 : 1,
                  borderRadius: 9,
                  boxShadow: !messagingBusy && offerSlug ? '4px 4px 0 var(--accent)' : 'none',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}>
                <Sparkles size={14} />
                {messagingBusy
                  ? `Generating ${nProblems + nCircumstances + nOutcomes}…`
                  : `Generate ${nProblems + nCircumstances + nOutcomes} angles`}
              </button>
            </div>
            {messagingBusy && (
              <div style={{ marginTop: 14 }}>
                <GenProgress kind="angles" total={nProblems + nCircumstances + nOutcomes} />
              </div>
            )}
            {messagingResult?.save_error && (
              <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2',
                            border: '1px solid #fca5a5', color: 'var(--down)', fontSize: 13 }}>
                Save error: {messagingResult.save_error}
              </div>
            )}
          </div>

          {/* Advanced expander — niche hint + extra instructions live here. */}
          {(() => {
            const advHasContent = !!(nicheHint.trim() || extraInstructions.trim())
            return (
              <AdvancedExpander defaultOpen={advHasContent}>
                <Block title="Niche or situation (optional)" dense
                  hint='Bias the angles toward a specific niche. Empty = use the offer&apos;s primary audience as-is. Example: "CPA firms at $50k+/month watching Bench eat bookkeeping clients."'>
                  <textarea value={nicheHint} onChange={e => setNicheHint(e.target.value)}
                    rows={3} placeholder="(optional)"
                    style={{
                      width: '100%', maxWidth: 720, padding: '10px 12px',
                      fontFamily: 'var(--sans)', fontSize: 14,
                      border: '1px solid var(--rule)', background: 'var(--paper)',
                      color: 'var(--ink)', resize: 'vertical', borderRadius: 9, outline: 'none',
                    }} />
                </Block>
                <Block title="Anything specific to mention?" dense
                  hint='Free-text appended to Claude. e.g. "Lead with Eric&apos;s $215K close", "don&apos;t mention guarantees", "bias toward founders in their first 12 months".'>
                  <ExtraInstructionsField value={extraInstructions} onChange={setExtraInstructions} />
                </Block>
              </AdvancedExpander>
            )
          })()}

          {/* Persistent saved-angle library for this offer. Always visible
              so the operator can review prior messaging without re-running.
              Dedup happens in refreshMessagingLibrary (case-insensitive
              name). Retire button calls .update({active:false}) so the
              angle disappears from both this list and the Scripts picker. */}
          {offerSlug && (
            <div style={{ marginTop: 36, marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <Eyebrow style={{ marginBottom: 4 }}>Saved for this offer</Eyebrow>
                  <h2 style={{
                    margin: 0, fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400,
                  }}>
                    {messagingLibraryLoading
                      ? 'Loading…'
                      : `${messagingLibrary.length} ${messagingLibrary.length === 1 ? 'angle' : 'angles'} in library`}
                  </h2>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => setFindSimilar(s => !s)}
                    title="Group near-duplicate angles by normalized name so you can spot clusters fast"
                    style={{
                      padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: `1px solid ${findSimilar ? '#3068b5' : 'var(--rule)'}`,
                      background: findSimilar ? '#eaf1fb' : 'transparent',
                      color: findSimilar ? '#3068b5' : 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
                    }}>{findSimilar ? '✓ Grouped' : 'Find similar'}</button>
                  <button onClick={() => refreshMessagingLibrary(offerSlug)}
                    style={{
                      padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                      border: '1px solid var(--rule)', background: 'transparent',
                      color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
                    }}>Refresh</button>
                  <button onClick={() => setAngleEditorTarget({ mode: 'create', angle: null })}
                    title="Add a custom angle to the library (skip Claude generation)"
                    style={{
                      padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                      letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                      border: '1px solid #1a242c', background: '#1a242c',
                      color: 'var(--paper)', cursor: 'pointer', borderRadius: 9,
                    }}>+ Custom angle</button>
                </div>
              </div>
              {/* Bulk action bar — appears when any tile is selected. Sticky at
                  the top of the library so the operator never loses sight of
                  what's selected while scrolling through 135 angles. */}
              {selectedAngleSlugs.size > 0 && (
                <div style={{
                  position: 'sticky', top: 0, zIndex: 5,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 12, flexWrap: 'wrap',
                  padding: '10px 14px', marginBottom: 12,
                  background: '#1a242c', color: 'var(--paper)',
                  border: '1px solid #1a242c', borderRadius: 9,
                  fontFamily: 'var(--mono)', fontSize: 12,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ fontWeight: 700, letterSpacing: '0.04em' }}>
                      {selectedAngleSlugs.size} selected
                    </span>
                    <button onClick={() => selectAllVisible(messagingLibrary.map(a => a.slug))}
                      title="Select every angle in the library (across all clusters and types)"
                      style={{
                        padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.12em', textTransform: 'uppercase',
                        background: 'transparent', color: 'var(--paper)',
                        border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', borderRadius: 9,
                      }}>Select all {messagingLibrary.length} in library</button>
                    <button onClick={clearAngleSelection}
                      style={{
                        padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                        letterSpacing: '0.12em', textTransform: 'uppercase',
                        background: 'transparent', color: 'var(--paper)',
                        border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', borderRadius: 9,
                      }}>Clear</button>
                  </div>
                  <button onClick={() => setBulkRetireOpen(true)}
                    style={{
                      padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                      letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                      background: 'var(--down)', color: 'var(--paper)',
                      border: '1px solid var(--down)', cursor: 'pointer', borderRadius: 9,
                    }}>Retire {selectedAngleSlugs.size}</button>
                </div>
              )}
              {!messagingLibraryLoading && messagingLibrary.length === 0 ? (
                <div style={{
                  padding: '16px 18px', background: 'var(--paper)',
                  border: '1px dashed var(--rule)', fontFamily: 'var(--serif)',
                  fontSize: 14, fontStyle: 'italic', color: 'var(--ink-4)',
                }}>
                  Nothing saved yet for this offer. Generate problems/desires above
                  to build the library — they'll auto-save here and become
                  selectable in Scripts mode.
                </div>
              ) : findSimilar ? (
                <LibraryClusterView
                  angles={messagingLibrary}
                  proofs={proofsByAngle}
                  selected={selectedAngleSlugs}
                  onToggleSelect={toggleSelectAngle}
                  onSelectCluster={(slugs) => setSelectedAngleSlugs(prev => {
                    const next = new Set(prev); slugs.forEach(s => next.add(s)); return next
                  })}
                  onRetire={(a) => setRetireAngleTarget({ slug: a.slug, name: a.name })}
                  onOpenProofs={(a) => setProofEditorAngle(a)}
                  onEdit={(a) => setAngleEditorTarget({ mode: 'edit', angle: a })}
                />
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
                  gap: 14,
                }}>
                  {messagingLibrary.map(a => (
                    <LibraryAngleTile key={a.slug} angle={a}
                      proofs={proofsByAngle[a.slug] || []}
                      selected={selectedAngleSlugs.has(a.slug)}
                      onToggleSelect={() => toggleSelectAngle(a.slug)}
                      onRetire={() => setRetireAngleTarget({ slug: a.slug, name: a.name })}
                      onOpenProofs={() => setProofEditorAngle(a)}
                      onEdit={() => setAngleEditorTarget({ mode: 'edit', angle: a })}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Output — generated angles, auto-saved */}
          {messagingResult?.angles?.length > 0 && (
            <div style={{ marginTop: 32, marginBottom: 24 }}>
              <div style={{ marginBottom: 14 }}>
                <Eyebrow style={{ marginBottom: 4 }}>Output · auto-saved to library</Eyebrow>
                <h2 style={{ margin: 0, fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 400 }}>
                  {messagingResult.angles.length} angles for {messagingResult.offer?.name}
                </h2>
                {/* Grounding banner — tells the operator whether Claude
                    saw real forum/article snippets this run, or generated
                    from training-data reasoning only. The Edge Function
                    sets messagingResult.grounding = {enabled, query, hits}. */}
                {messagingResult.grounding && (
                  <div style={{
                    marginTop: 10, padding: '10px 14px',
                    background: messagingResult.grounding.hits > 0 ? '#eef6ee' : '#fef6e6',
                    border: `1px solid ${messagingResult.grounding.hits > 0 ? '#bcd9be' : '#e8c98a'}`,
                    fontFamily: 'var(--sans)', fontSize: 12.5,
                    color: messagingResult.grounding.hits > 0 ? '#2f5f33' : '#7a5810',
                    borderRadius: 9, lineHeight: 1.45,
                  }}>
                    {messagingResult.grounding.hits > 0 ? (
                      <>
                        <strong>Grounded</strong> · {messagingResult.grounding.hits} real
                        source{messagingResult.grounding.hits === 1 ? '' : 's'} fed to
                        Claude for query <code style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                          {messagingResult.grounding.query}
                        </code>. Click any angle below to see which sources it cited.
                      </>
                    ) : messagingResult.grounding.enabled ? (
                      <>
                        <strong>No grounding hits</strong> · search ran but returned no
                        usable results. Angles are reasoned from training data only —
                        sources arrays will be empty.
                      </>
                    ) : (
                      <>
                        <strong>Grounding disabled</strong> · SERPER_API_KEY not set on
                        the Edge Function. Angles are reasoned from training data only
                        (no fabricated sources). Set the key in Supabase Studio →
                        Edge Functions → secrets to enable real sourcing.
                      </>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gap: 12 }}>
                {messagingResult.angles.map((a, i) => (
                  <AngleCard key={i} angle={a} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ──── SCRIPTS MODE — simplified flow (Ben 2026-05-31) ──── */}
      {genTarget === 'scripts' && (
        <>
          {!offerSlug && (
            <div style={{
              padding: '14px 18px', marginBottom: 20,
              background: 'var(--paper)', border: '1px solid var(--rule)',
              fontFamily: 'var(--serif)', fontSize: 14, fontStyle: 'italic',
              color: 'var(--ink-3)',
            }}>
              Pick an offer above to load its angle library.
            </div>
          )}
          {offerSlug && angles.length === 0 && (
            <div style={{
              padding: '14px 18px', marginBottom: 20,
              background: '#fff3d1', border: '1px solid #d68f00', borderLeft: '4px solid #d68f00',
              fontFamily: 'var(--mono)', fontSize: 12.5, color: '#4d3000',
              lineHeight: 1.5,
            }}>
              No angles saved for <strong>{selectedOffer?.name || offerSlug}</strong> yet.
              Switch to <strong>Messaging</strong> above to generate problems + desires
              for this offer — they auto-save to the library and become selectable here.
            </div>
          )}

          {/* Angles — primary decision. */}
          <Block title="Angles"
            hint="Click any angle to add it to the batch. Each selected angle gets its own run — pick 3 angles × 2 script types = 6 batches in parallel.">
            <div style={{ display: 'flex', alignItems: 'baseline',
                          justifyContent: 'space-between', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5,
                            letterSpacing: '0.14em', textTransform: 'uppercase',
                            color: 'var(--ink-4)' }}>
                {angleSlugs.length === 0
                  ? 'Nothing selected yet'
                  : `${angleSlugs.length} selected · ${angles.length - angleSlugs.length} remaining`}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={() => setAngleSlugs(angles.map(a => a.slug))}
                  style={pillButtonStyle(false)}>Select all ({angles.length})</button>
                {angleSlugs.length > 0 && (
                  <button onClick={() => setAngleSlugs([])}
                    style={pillButtonStyle(false)}>Clear</button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {angles.map(a => (
                <AngleChip key={a.slug}
                  angle={a}
                  selected={angleSlugs.includes(a.slug)}
                  proofCount={proofsByAngle[a.slug]?.length ?? null}
                  onToggle={() => setAngleSlugs(prev =>
                    prev.includes(a.slug) ? prev.filter(s => s !== a.slug) : [...prev, a.slug])}
                  onOpenProofs={() => setProofEditorAngle(a)}
                />
              ))}
            </div>
            {primaryAngleSlug && (() => {
              const a = angles.find(x => x.slug === primaryAngleSlug)
              if (!a) return null
              return (
                <div style={{
                  marginTop: 12, padding: '10px 14px',
                  background: 'var(--paper)', border: '1px solid var(--rule)',
                  fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-2)',
                  lineHeight: 1.5,
                }}>
                  <strong style={{ fontFamily: 'var(--mono)', fontSize: 10.5,
                                   letterSpacing: '0.1em', textTransform: 'uppercase',
                                   color: 'var(--ink-3)' }}>Qualifier:</strong> {a.qualifier}<br/>
                  <strong style={{ fontFamily: 'var(--mono)', fontSize: 10.5,
                                   letterSpacing: '0.1em', textTransform: 'uppercase',
                                   color: 'var(--ink-3)' }}>Promise:</strong> {a.primary_promise}<br/>
                  <strong style={{ fontFamily: 'var(--mono)', fontSize: 10.5,
                                   letterSpacing: '0.1em', textTransform: 'uppercase',
                                   color: 'var(--ink-3)' }}>Mechanism:</strong> {a.mechanism_short}
                </div>
              )
            })()}
          </Block>

          {/* Proof-source preview — shows the operator EXACTLY which
              proofs Claude will rotate through for the selected angles.
              Updates live when angle selection changes. */}
          {angleSlugs.length > 0 && (() => {
            // Aggregate proofs across all selected angles, group by type.
            const all = []
            const missing = []
            for (const slug of angleSlugs) {
              const list = proofsByAngle[slug] || []
              if (list.length === 0) missing.push(slug)
              for (const p of list) all.push({ ...p, _angle: slug })
            }
            const byType = {}
            const typeOrder = []
            for (const p of all) {
              const t = p.proof_type || 'case_study'
              if (!byType[t]) { byType[t] = []; typeOrder.push(t) }
              byType[t].push(p)
            }
            return (
              <div style={{
                marginBottom: 20, padding: '12px 14px',
                background: 'var(--paper)', border: '1px solid var(--rule)',
                borderLeft: '3px solid var(--accent)', borderRadius: 9,
              }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.14em',
                  textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
                  marginBottom: 8,
                }}>
                  Will pull proofs from
                </div>
                {all.length === 0 ? (
                  <div style={{
                    fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                    color: '#7a5810', lineHeight: 1.5,
                  }}>
                    No proofs saved across the {angleSlugs.length === 1 ? 'selected angle' : `${angleSlugs.length} selected angles`} yet.
                    Generate will auto-create a diverse mix (case study + statistic +
                    testimonial/authority) before drafting scripts. Click the gear on
                    any angle chip to add proofs yourself first.
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {typeOrder.map(t => (
                        <span key={t} style={{
                          fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
                          textTransform: 'uppercase', color: 'var(--ink)', fontWeight: 600,
                          padding: '3px 8px', background: 'var(--paper)',
                          border: '1px solid var(--ink)', borderRadius: 9,
                        }}>
                          {t.replace('_', ' ')} <span style={{ opacity: 0.6, marginLeft: 2 }}>×{byType[t].length}</span>
                        </span>
                      ))}
                    </div>
                    <div style={{
                      fontFamily: 'var(--serif)', fontSize: 12.5, color: 'var(--ink-3)',
                      lineHeight: 1.5,
                    }}>
                      {all.slice(0, 6).map((p, i) => (
                        <span key={i}>
                          <strong style={{ color: 'var(--ink-2)' }}>{p.name}</strong>
                          {' — '}{(p.result_short || '').slice(0, 60)}{(p.result_short || '').length > 60 ? '…' : ''}
                          {i < Math.min(all.length, 6) - 1 ? ' · ' : ''}
                        </span>
                      ))}
                      {all.length > 6 && <span style={{ color: 'var(--ink-4)' }}> · +{all.length - 6} more</span>}
                    </div>
                    {missing.length > 0 && (
                      <div style={{
                        marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)',
                        fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12,
                        color: '#7a5810',
                      }}>
                        {missing.length} of {angleSlugs.length} selected angles have no proofs yet — those will get auto-generated on Generate.
                      </div>
                    )}
                  </>
                )}
                <InlineProofAdder
                  angleSlugs={angleSlugs}
                  angles={angles}
                  onAdded={(slug) => refreshProofCount(slug)}
                />
              </div>
            )
          })()}

          {/* Script types — multi-select. */}
          <Block title="Script types"
            hint="Pick one or more. Each selected type runs its own batch.">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { v: 'hook',   label: 'Hooks',    desc: 'Standalone openings — 60-90 words. Filter by shape (A-H) under Advanced.' },
                { v: 'body',   label: 'Bodies',   desc: 'Full body copy on the 7-beat skeleton. Pair with any hook later.' },
                { v: 'joined', label: 'Joined',   desc: 'Hook + Body chained. Same proof character + posture through both.' },
              ].map(opt => {
                const on = scriptTypes.includes(opt.v)
                return (
                  <button key={opt.v}
                    onClick={() => setScriptTypes(prev =>
                      prev.includes(opt.v) ? prev.filter(t => t !== opt.v) : [...prev, opt.v])}
                    style={{
                      flex: '1 1 240px', maxWidth: 380,
                      padding: '14px 16px', textAlign: 'left',
                      border: `2px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                      background: on ? 'var(--ink)' : 'var(--paper)',
                      color: on ? 'var(--paper)' : 'var(--ink)',
                      cursor: 'pointer', borderRadius: 9,
                      display: 'flex', flexDirection: 'column', gap: 4,
                      position: 'relative',
                    }}>
                    {on && <Check size={14} style={{ position: 'absolute', top: 12, right: 12 }} />}
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                      letterSpacing: '0.12em', textTransform: 'uppercase',
                    }}>{opt.label}</span>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 12.5,
                                   fontStyle: 'italic', opacity: 0.85, lineHeight: 1.4 }}>
                      {opt.desc}
                    </span>
                  </button>
                )
              })}
            </div>
          </Block>

          {/* Mode mix (Ben 2026-06-01) — Schwartz-aligned. Direct = Stage 1-2
              claim-led. Hybrid = Stage 2-3 claim + emerging mechanism.
              Educational = Stage 3-4 mechanism-led (where most of the
              conversion lift is in saturated markets like restoration,
              roofing, plumbing). Each mode runs its OWN batch with its
              own quota, fanned out per (angle × script-type × mode). */}
          <Block title="Mode mix"
            hint="How many scripts of each mode per (angle × type). Set 0 to skip a mode. Total = sum.">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                { v: 'direct',      label: 'Direct',      stage: 'Schwartz Stage 1-2 · claim-led',
                  desc: 'Qualifier + promise + mechanism (named) + guarantee. Fastest path to CTA. Converts on warm traffic where the prospect already knows they have the problem.' },
                { v: 'hybrid',      label: 'Hybrid',      stage: 'Stage 2-3 · claim + emerging mechanism',
                  desc: 'Direct flow with ONE mechanism-reveal beat (e.g. "Google weighs response time 3x more than bid") woven into the pattern statement. Best A/B candidate against pure Direct on slightly-cold traffic.' },
                { v: 'educational', label: 'Educational', stage: 'Stage 3-4 · mechanism-led',
                  desc: 'Mechanism IS the headline; claim follows. Body teaches throughout — each beat advances the lesson. Hook uses curiosity / reframe / trend shape. Soft "learn more" CTA. For saturated markets where every claim has been heard.' },
                { v: 'rom',         label: 'ROM',         stage: 'Diverse hook · locked body · offer at close',
                  desc: 'Validated 2026-06-09. Diverse hook shape on every script (insight reveal, AI shift, mechanism, pattern interrupt, story, mistake, identity, qualifier-led, trend, outcome, fire-agency). Locked body skeleton — setup + named proof + "Here\'s the truth Google won\'t say out loud" reveal + "#1 in 90 days or money back" offer at the close. Never the hook. For $50K+/mo solution-aware operators.' },
              ].map(opt => {
                const n = modeQuotas[opt.v] || 0
                const on = n > 0
                return (
                  <div key={opt.v}
                    style={{
                      flex: '1 1 280px', maxWidth: 420,
                      padding: '14px 16px',
                      border: `2px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                      background: on ? 'var(--paper)' : 'var(--paper)',
                      borderRadius: 9,
                      display: 'flex', flexDirection: 'column', gap: 8,
                    }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                      <div>
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                          letterSpacing: '0.12em', textTransform: 'uppercase',
                          color: 'var(--ink)',
                        }}>{opt.label}</div>
                        <div style={{
                          fontFamily: 'var(--mono)', fontSize: 9.5,
                          letterSpacing: '0.08em', textTransform: 'uppercase',
                          color: 'var(--ink-4)', marginTop: 2,
                        }}>{opt.stage}</div>
                      </div>
                      <input type="number" min={0} max={30} value={n}
                        onChange={e => {
                          const v = Math.max(0, Math.min(30, parseInt(e.target.value) || 0))
                          setModeQuotas(prev => ({ ...prev, [opt.v]: v }))
                        }}
                        title="Number of scripts of this mode per (angle × type). Set 0 to skip."
                        style={{
                          width: 56, padding: '6px 8px',
                          fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 700, textAlign: 'center',
                          border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                          background: 'var(--paper)', borderRadius: 9,
                        }} />
                    </div>
                    <div style={{
                      fontFamily: 'var(--serif)', fontSize: 12, fontStyle: 'italic',
                      color: 'var(--ink-3)', lineHeight: 1.45,
                    }}>
                      {opt.desc}
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 'auto', paddingTop: 6 }}>
                      {[0, 3, 5, 10].map(q => (
                        <button key={q}
                          onClick={() => setModeQuotas(prev => ({ ...prev, [opt.v]: q }))}
                          style={{
                            padding: '4px 9px',
                            fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                            border: `1px solid ${n === q ? 'var(--ink)' : 'var(--rule)'}`,
                            background: n === q ? 'var(--accent)' : 'transparent',
                            color: 'var(--ink)', cursor: 'pointer', borderRadius: 9,
                          }}>{q}</button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
            {nConcepts > 0 && (
              <div style={{
                marginTop: 12, padding: '8px 12px',
                background: 'var(--paper)', border: '1px solid var(--rule)',
                fontFamily: 'var(--mono)', fontSize: 11.5,
                color: 'var(--ink-2)', letterSpacing: '0.04em', borderRadius: 9,
              }}>
                Total per (angle × type): <strong>{nConcepts}</strong>
                {activeModes.length > 1 && (
                  <> · split {activeModes.map(m => `${modeQuotas[m]} ${m}`).join(' + ')}</>
                )}
              </div>
            )}
          </Block>

          {/* Use mechanism toggle (Ben 2026-06-01 PM — "some scripts are
              generating the mechanism name and some aren't; I want to be
              able to select whether we're using the mechanism or not").
              Binary on/off. ON = include the offer's brand-named mechanism
              in the prompt (default). OFF = strip it, scripts reveal
              capabilities in plain language only. */}
          <Block title="Mechanism reveal" dense
            hint="Should the offer's brand-named mechanism appear in the script? Toggle off if you want plain-language scripts that describe what we do without the brand name.">
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { v: true,  label: 'Use mechanism',
                  desc: "Scripts reference the offer's brand-named mechanism (e.g. \"The Direct Call Engine\"). Best when the prospect needs a memorable handle on the system." },
                { v: false, label: 'No mechanism',
                  desc: "Scripts describe what we do in plain language without naming a branded system. Useful for Educational mode and cold traffic where the brand-name reveal feels forced." },
              ].map(opt => {
                const on = useMechanism === opt.v
                return (
                  <button key={String(opt.v)} onClick={() => setUseMechanism(opt.v)}
                    title={opt.desc}
                    style={{
                      flex: '1 1 280px', maxWidth: 420, textAlign: 'left',
                      padding: '12px 14px',
                      border: `2px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                      background: on ? 'var(--paper)' : 'var(--paper)',
                      color: 'var(--ink)', cursor: 'pointer', borderRadius: 9,
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                                  letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                      {on && <Check size={11} style={{ display: 'inline', marginRight: 6, verticalAlign: 'middle' }} />}
                      {opt.label}
                    </span>
                    <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic',
                                   fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.45 }}>
                      {opt.desc}
                    </span>
                  </button>
                )
              })}
            </div>
          </Block>

          {/* Count + Generate row — no Section eyebrow, just an inline cluster. */}
          {(() => {
            const totalBatches = angleSlugs.length * scriptTypes.length
            const totalScripts = totalBatches * nConcepts
            const disabled = generating || !angleSlugs.length || !scriptTypes.length || nConcepts === 0
            const buttonLabel = (() => {
              if (generating) return `Generating ${totalScripts}…`
              if (totalBatches === 0) return 'Pick angles + script types'
              if (totalBatches === 1) {
                const t = scriptTypes[0]
                return `Generate ${nConcepts} ${t === 'body' ? 'bodies' : t === 'joined' ? 'joined scripts' : t + (nConcepts > 1 ? 's' : '')}`
              }
              return `Generate ${totalScripts} (${angleSlugs.length} × ${scriptTypes.length} × ${nConcepts})`
            })()
            return (
              <div style={{
                marginTop: 8, marginBottom: 6,
                padding: '16px 18px', background: 'var(--paper)',
                border: '1px solid var(--rule)', borderTop: '3px solid var(--ink)',
                borderRadius: 9,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
                  <div style={{
                    fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)',
                    letterSpacing: '0.06em',
                  }}>
                    {nConcepts > 0
                      ? `${totalScripts} scripts queued · ${nConcepts}/angle×type${activeModes.length > 1 ? ` (${activeModes.map(m => `${modeQuotas[m]} ${m}`).join(' + ')})` : ` (${activeModes[0] || 'direct'})`}`
                      : 'Set at least one mode quota above to enable generation.'}
                  </div>
                  <button onClick={handleGenerate} disabled={disabled || nConcepts === 0}
                    style={{
                      marginLeft: 'auto',
                      padding: '14px 24px', fontFamily: 'var(--mono)', fontSize: 12,
                      letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 700,
                      border: '2px solid var(--ink)',
                      background: generating ? 'var(--ink-3)' : 'var(--ink)',
                      color: 'var(--paper)', cursor: disabled ? 'not-allowed' : (generating ? 'wait' : 'pointer'),
                      opacity: disabled && !generating ? 0.4 : 1, borderRadius: 9,
                      boxShadow: !disabled ? '4px 4px 0 var(--accent)' : 'none',
                      transition: 'all 140ms ease',
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                    }}>
                    <Sparkles size={14} />
                    {buttonLabel}
                  </button>
                </div>
                {selectedOffer?.has_dual_guarantee && (
                  <div style={{
                    marginTop: 12, fontFamily: 'var(--serif)', fontSize: 12.5,
                    fontStyle: 'italic', color: 'var(--ink-4)', lineHeight: 1.45,
                  }}>
                    Dual-guarantee close in play: top 3 Maps + crews booked, money back if neither.
                  </div>
                )}
                {generating && (
                  <div style={{ marginTop: 14 }}>
                    <GenProgress
                      kind={scriptTypes.length === 1
                        ? (scriptTypes[0] === 'hook' ? 'hooks' : scriptTypes[0] === 'body' ? 'bodies' : 'joined')
                        : 'mixed'}
                      total={totalScripts}
                      fanout={totalBatches > 1 ? fanProgress : null}
                    />
                  </div>
                )}
              </div>
            )
          })()}

          {/* Advanced expander — everything optional lives here. Auto-opens
              when the operator has anything non-default set so they can see
              their settings without an extra click. */}
          {(() => {
            const advHasContent = !!(
              extraInstructions.trim() ||
              mechanismSlug ||
              targetShapes.length ||
              selectedProofNames.length ||
              (primaryAngleSlug && proofCharacters.length === 0)   // surface the "needs proofs" state
            )
            return (
              <AdvancedExpander defaultOpen={advHasContent}>
                {/* Extra instructions — most-used; first inside Advanced. */}
                <Block title="Anything specific to mention?" dense
                  hint='Free-text instructions appended to Claude. Use this for "lead with Eric&apos;s $215K close", "don&apos;t mention guarantees", or "use Adam as proof character for all hooks". Blank = default prompt.'>
                  <ExtraInstructionsField value={extraInstructions} onChange={setExtraInstructions} />
                </Block>

                {/* Proof characters — single-angle only. */}
                {primaryAngleSlug && (
                  <Block title="Proof characters" dense
                    hint="Named clients with a one-line result. Generator rotates through them. (Multi-angle runs use each angle's own.)">
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                      <button onClick={() => setProofEditorAngle(angles.find(a => a.slug === primaryAngleSlug) || null)}
                        style={{
                          padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                          border: '1px solid var(--ink)', background: 'var(--paper)',
                          color: 'var(--ink)', cursor: 'pointer', borderRadius: 9,
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                        }}>
                        <Settings size={12} />
                        Manage ({proofCharacters.length})
                      </button>
                    </div>
                    {proofCharacters.length === 0 ? (
                      <div style={{
                        padding: '10px 14px', background: '#fef6e6',
                        border: '1px solid #e8c98a',
                        fontFamily: 'var(--sans)', fontStyle: 'italic',
                        fontSize: 12.5, color: '#7a5810', lineHeight: 1.5,
                      }}>
                        None saved yet. Generate will auto-create 4 proofs for this angle
                        before drafting scripts. Click <strong>Manage</strong> if you want
                        to edit them yourself first.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <button onClick={() => setSelectedProofNames([])}
                          style={{
                            padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                            letterSpacing: '0.1em', textTransform: 'uppercase',
                            fontWeight: selectedProofNames.length === 0 ? 700 : 500,
                            border: `1px solid ${selectedProofNames.length === 0 ? 'var(--ink)' : 'var(--rule)'}`,
                            background: selectedProofNames.length === 0 ? 'var(--ink)' : 'var(--paper)',
                            color: selectedProofNames.length === 0 ? 'var(--paper)' : 'var(--ink-3)',
                            cursor: 'pointer', borderRadius: 9,
                          }}>
                          All ({proofCharacters.length})
                        </button>
                        {proofCharacters.map(p => {
                          const on = selectedProofNames.includes(p.name)
                          return (
                            <button key={p.id}
                              onClick={() => setSelectedProofNames(prev =>
                                prev.includes(p.name) ? prev.filter(n => n !== p.name) : [...prev, p.name])}
                              title={p.result_short}
                              style={{
                                padding: '8px 12px', fontFamily: 'var(--sans)', fontSize: 12.5,
                                border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                                background: on ? 'var(--ink)' : 'var(--paper)',
                                color: on ? 'var(--paper)' : 'var(--ink-2)',
                                cursor: 'pointer', borderRadius: 9,
                                display: 'inline-flex', alignItems: 'center', gap: 6,
                              }}>
                              {on && <Check size={12} />}
                              <span style={{ fontWeight: on ? 600 : 400 }}>{p.name}</span>
                              <span style={{ opacity: 0.7, fontSize: 11 }}>
                                — {(p.result_short || '').slice(0, 48)}{(p.result_short || '').length > 48 ? '…' : ''}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </Block>
                )}

                {/* Mechanism — single-angle only. */}
                {primaryAngleSlug && (
                  <Block title="Mechanism" dense
                    hint='A named system you sell — "The Direct CPA Engine", "The Pipe Flow Method". Not a strategy or transition. Leave unselected to use the angle&apos;s default.'>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <button onClick={() => setMechanismSlug('')}
                        style={{
                          padding: '10px 14px',
                          border: `2px dashed ${mechanismSlug === '' ? 'var(--ink)' : 'var(--rule)'}`,
                          background: mechanismSlug === '' ? 'var(--ink)' : 'var(--paper)',
                          color: mechanismSlug === '' ? 'var(--paper)' : 'var(--ink-3)',
                          fontFamily: 'var(--sans)', fontSize: 14, fontWeight: mechanismSlug === '' ? 600 : 400,
                          cursor: 'pointer', borderRadius: 9,
                        }}>None — use angle default</button>
                      {mechanisms.map(m => {
                        const on = m.slug === mechanismSlug
                        return (
                          <div key={m.slug} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                            <button onClick={() => setMechanismSlug(m.slug)}
                              title={m.summary || ''}
                              style={{
                                padding: '10px 14px',
                                border: `2px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                                borderRight: on ? '2px solid var(--ink)' : 'none',
                                background: on ? 'var(--ink)' : 'var(--paper)',
                                color: on ? 'var(--paper)' : 'var(--ink)',
                                fontFamily: 'var(--sans)', fontSize: 14, fontWeight: on ? 600 : 400,
                                cursor: 'pointer', borderRadius: '2px 0 0 2px',
                                display: 'inline-flex', alignItems: 'center', gap: 8,
                              }}>
                              {on && <Check size={14} />}
                              <span>{m.name}</span>
                            </button>
                            <button onClick={() => openConfigureMechanism(m)}
                              title="Configure mechanism"
                              style={{
                                padding: '10px 8px',
                                border: `2px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                                borderLeft: '1px solid var(--rule)',
                                background: on ? 'var(--ink)' : 'var(--paper)',
                                color: on ? 'var(--paper)' : 'var(--ink-3)',
                                cursor: 'pointer', borderRadius: '0 2px 2px 0',
                                display: 'inline-flex', alignItems: 'center',
                              }}>
                              <Settings size={14} />
                            </button>
                          </div>
                        )
                      })}
                      <button onClick={openNewMechanism}
                        style={{
                          padding: '10px 16px',
                          border: '2px dashed var(--rule)', background: 'transparent',
                          color: 'var(--ink-3)',
                          fontFamily: 'var(--sans)', fontSize: 14,
                          cursor: 'pointer', borderRadius: 9,
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                        }}>
                        <Plus size={14} />
                        New mechanism
                      </button>
                    </div>
                  </Block>
                )}

                {/* Hook shapes filter retired (Ben 2026-06-01) — was overkill.
                    Generator now rotates all 8 shapes automatically across
                    the batch. */}

                {/* Target length — only when a single script type is selected.
                    Mixed runs (hooks + bodies + joined) use sensible per-type
                    defaults so the operator gets a varied mix without having
                    to pick a length that doesn't apply to all of them. */}
                {scriptTypes.length === 1 &&
                 (scriptTypes.includes('body') || scriptTypes.includes('joined')) && (
                  <Block title="Target length" dense>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[
                        { v: 'under_60s', label: 'Under 60s', desc: 'Tight body, single proof beat' },
                        { v: '60_75s',    label: '60-75s',    desc: 'Canonical OPT length, full skeleton' },
                        { v: '75s_plus',  label: '75s+',      desc: 'Full scene paint, extended proof roster' },
                      ].map(opt => {
                        const on = targetLength === opt.v
                        return (
                          <button key={opt.v} onClick={() => setTargetLength(opt.v)}
                            title={opt.desc}
                            style={{
                              padding: '10px 16px',
                              border: `1px solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                              background: on ? 'var(--accent)' : 'var(--paper)',
                              color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                              cursor: 'pointer', borderRadius: 9,
                            }}>{opt.label}</button>
                        )
                      })}
                    </div>
                  </Block>
                )}
              </AdvancedExpander>
            )
          })()}

          {/* Modal mounts — outside the expander so they render on top. */}
          <MechanismConfigModal
            open={mechanismModalOpen}
            existing={mechanismModalExisting}
            offers={offers}
            angles={angles}
            onClose={() => setMechanismModalOpen(false)}
            onSaved={handleMechanismSaved}
          />
          <AngleEditorModal
            open={!!angleEditorTarget}
            angle={angleEditorTarget?.angle}
            mode={angleEditorTarget?.mode || 'edit'}
            offerSlug={offerSlug}
            angleType={angleEditorTarget?.angle?.angle_type || 'outcome'}
            onClose={() => setAngleEditorTarget(null)}
            onSaved={(savedSlug) => {
              // Refresh the library so the new/edited angle shows up. If we
              // just CREATED an angle, also pre-select it so the next script
              // run uses it immediately.
              refreshMessagingLibrary(offerSlug)
              if (angleEditorTarget?.mode === 'create' && savedSlug) {
                setAngleSlugs(prev => prev.includes(savedSlug) ? prev : [...prev, savedSlug])
              }
            }}
          />
          <ProofCharacterEditor
            open={!!proofEditorAngle}
            angle={proofEditorAngle}
            onClose={() => setProofEditorAngle(null)}
            onSaved={() => {
              if (proofEditorAngle?.slug) refreshProofCount(proofEditorAngle.slug)
            }}
          />
        </>
      )}

      {/* ──── LEGACY ATTRIBUTE MODE SECTIONS ──── */}
      {generatorMode === 'attributes' && (
      <>
      {/* Step 1: pick offer */}
      <Section label="01" title="Pick an offer">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {offers.map(o => {
            const selected = o.slug === offerSlug
            const isStub = o.slug.includes('stub') || o.slug.includes('template')
            const incomplete = !o.mechanism_name || !o.primary_audience
            return (
              <div key={o.slug} style={{ display: 'inline-flex', alignItems: 'stretch' }}>
                <button
                  onClick={() => setOfferSlug(o.slug)}
                  style={{
                    padding: '10px 14px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderRight: selected ? '2px solid var(--ink)' : 'none',
                    background: selected ? 'var(--ink)' : 'var(--paper)',
                    color: selected ? 'var(--paper)' : isStub ? 'var(--ink-4)' : 'var(--ink)',
                    fontFamily: 'var(--sans)', fontSize: 14, fontWeight: selected ? 600 : 400,
                    cursor: 'pointer', borderRadius: '2px 0 0 2px',
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    transition: 'all 140ms ease',
                  }}>
                  {selected && <Check size={14} />}
                  <span>{o.name}</span>
                  {incomplete && (
                    <span style={{ fontSize: 9, fontFamily: 'var(--mono)', letterSpacing: '0.1em',
                                  background: '#e0a93e', color: '#3b2a04', padding: '2px 5px',
                                  borderRadius: 9, textTransform: 'uppercase' }}>
                      needs config
                    </span>
                  )}
                </button>
                <button
                  onClick={() => openConfigureOffer(o)}
                  title="Configure offer"
                  style={{
                    padding: '10px 8px',
                    border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
                    borderLeft: '1px solid var(--rule)',
                    background: selected ? 'var(--ink)' : 'var(--paper)',
                    color: selected ? 'var(--paper)' : 'var(--ink-3)',
                    cursor: 'pointer', borderRadius: '0 2px 2px 0',
                    display: 'inline-flex', alignItems: 'center',
                  }}>
                  <Settings size={14} />
                </button>
              </div>
            )
          })}
          <button onClick={openNewOffer}
            style={{
              padding: '10px 16px',
              border: '2px dashed var(--rule)', background: 'transparent',
              color: 'var(--ink-3)',
              fontFamily: 'var(--sans)', fontSize: 14,
              cursor: 'pointer', borderRadius: 9,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              transition: 'all 140ms ease',
            }}>
            <Plus size={14} />
            New offer
          </button>
        </div>
        {(() => {
          const cur = offers.find(o => o.slug === offerSlug)
          if (!cur) return null
          if (!cur.mechanism_name || !cur.primary_audience) {
            return (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#fef9e7',
                            border: '1px solid #e0a93e', fontSize: 13, borderRadius: 9,
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic', color: '#7a5c12' }}>
                  This offer is missing {[!cur.mechanism_name && 'mechanism', !cur.primary_audience && 'audience'].filter(Boolean).join(' + ')}.
                  Generated scripts will be generic without it.
                </span>
                <button onClick={() => openConfigureOffer(cur)}
                  style={{ padding: '6px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                          letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
                          border: '1px solid #7a5c12', background: '#7a5c12', color: '#fef9e7',
                          cursor: 'pointer', borderRadius: 9 }}>
                  Configure now
                </button>
              </div>
            )
          }
          return null
        })()}
      </Section>

      <OfferConfigModal
        open={offerModalOpen}
        existing={offerModalExisting}
        onClose={() => setOfferModalOpen(false)}
        onSaved={handleOfferSaved}
      />

      {/* Step 2: how many concepts */}
      <Section label="02" title="How many concepts">
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {[5, 10, 15, 20, 30].map(n => (
              <button key={n} onClick={() => setNConcepts(n)}
                style={{
                  padding: '10px 20px',
                  border: `1px solid ${nConcepts === n ? 'var(--ink)' : 'var(--rule)'}`,
                  background: nConcepts === n ? 'var(--accent)' : 'var(--paper)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600,
                  cursor: 'pointer', borderRadius: 9,
                  transition: 'all 140ms ease',
                  minWidth: 70,
                }}>{n}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
                          textTransform: 'uppercase', color: 'var(--ink-4)' }}>Custom:</span>
            <input type="number" min={1} max={30} value={nConcepts}
              onChange={e => setNConcepts(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))}
              style={{
                width: 70, padding: '8px 10px',
                fontFamily: 'var(--mono)', fontSize: 14, textAlign: 'center',
                border: '1px solid var(--rule)', background: 'var(--paper)',
                borderRadius: 9,
              }} />
          </div>
        </div>
      </Section>

      {/* Step 3: mode */}
      <Section label="03" title="Generation mode">
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <ModeCard
            selected={mode === 'diverse'}
            onClick={() => setMode('diverse')}
            icon={<Layers size={18} />}
            title="Diverse batch"
            desc="Maximum variance across every attribute. Best for first-cycle exploration — produces a wide testing matrix where every concept has a different combination."
          />
          <ModeCard
            selected={mode === 'targeted'}
            onClick={() => setMode('targeted')}
            icon={<Zap size={18} />}
            title="Targeted"
            desc="Constrain specific attribute values. Best for A/B-isolated tests — e.g. fix mechanism_reveal=explicit, vary everything else."
          />
        </div>

        {/* Advanced — only relevant in targeted mode */}
        {mode === 'targeted' && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setAdvancedOpen(!advancedOpen)}
              style={{
                padding: '8px 12px', fontFamily: 'var(--mono)', fontSize: 11,
                letterSpacing: '0.12em', textTransform: 'uppercase',
                border: '1px solid var(--rule)', background: 'transparent',
                color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
              {advancedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {advancedOpen ? 'Hide constraints' : 'Add constraints'}
              {Object.keys(targets).length > 0 && (
                <span style={{ marginLeft: 6, padding: '1px 6px', fontSize: 9,
                              background: 'var(--accent)', color: 'var(--ink)',
                              fontWeight: 700, borderRadius: 9 }}>
                  {Object.keys(targets).length}
                </span>
              )}
            </button>

            {advancedOpen && (
              <div style={{ marginTop: 16, padding: 20, background: 'var(--paper)',
                            border: '1px solid var(--rule)', borderRadius: 9 }}>
                <p style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                            color: 'var(--ink-4)', margin: '0 0 16px' }}>
                  Pick values to include. Multiple values within one attribute = the system
                  will distribute scripts across those values. Leave empty = vary freely.
                </p>
                {FILTERABLE_ATTRS.map(f => {
                  const options = vocab?.[f.key] || []
                  const selected = targets[f.key] || []
                  return (
                    <div key={f.key} style={{ marginBottom: 16 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 11,
                                      letterSpacing: '0.12em', textTransform: 'uppercase',
                                      color: 'var(--ink-3)' }}>{f.label}</span>
                        {selected.length > 0 && (
                          <button onClick={() => setTargets(p => { const c = { ...p }; delete c[f.key]; return c })}
                            style={{ padding: '1px 6px', fontSize: 10, fontFamily: 'var(--mono)',
                                    background: 'transparent', color: 'var(--ink-4)',
                                    border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                            clear
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {options.map(o => {
                          const isOn = selected.includes(o.value)
                          return (
                            <button key={o.value}
                              onClick={() => toggleTarget(f.key, o.value)}
                              title={o.description}
                              style={{
                                padding: '6px 12px', fontSize: 12,
                                fontFamily: 'var(--sans)',
                                border: `1px solid ${isOn ? 'var(--ink)' : 'var(--rule)'}`,
                                background: isOn ? 'var(--ink)' : 'var(--paper)',
                                color: isOn ? 'var(--paper)' : 'var(--ink-3)',
                                cursor: 'pointer', borderRadius: 9,
                                transition: 'all 120ms ease',
                              }}>
                              {o.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </Section>
      </>
      )}

      {/* Result panel — Scripts mode only. Grouped by script type when
          a multi-type run was fired so the operator can scan all hooks
          first, then all bodies, then all joined. */}
      {genTarget === 'scripts' && result?.scripts?.length > 0 && (() => {
        // Group by _combo.script_type (set by handleGenerate fan-out).
        // Falls back to a single 'all' group when the combos are missing.
        const groups = {}
        const order = []
        for (const s of result.scripts) {
          const t = s._combo?.script_type || 'all'
          if (!groups[t]) { groups[t] = []; order.push(t) }
          groups[t].push(s)
        }
        // angle slug -> angle row, computed once and passed to every tile so
        // each card can render the angle name + type without re-looking up.
        const resultAngleLookup = buildAngleLookup([...(messagingLibrary || []), ...(angles || [])])
        const typeLabel = (t) => t === 'hook' ? 'Hooks'
          : t === 'body' ? 'Bodies'
          : t === 'joined' ? 'Joined' : 'All scripts'
        return (
          <div style={{ marginTop: 40, marginBottom: 32 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 16, marginBottom: 14,
            }}>
              <div>
                <Eyebrow style={{ marginBottom: 4 }}>Output</Eyebrow>
                <h2 style={{
                  margin: 0, fontSize: 18, lineHeight: 1.2, color: 'var(--ink)',
                  letterSpacing: '-0.005em', fontFamily: 'var(--sans)', fontWeight: 600,
                }}>
                  {result.scripts.length} scripts generated{order.length > 1 ? ` · ${order.length} groups` : ''}
                </h2>
              </div>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-4)',
                letterSpacing: '0.04em', textTransform: 'uppercase',
              }}>
                {result.model}
              </span>
            </div>
            {order.map(t => (
              <div key={t} style={{ marginBottom: 24 }}>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10,
                  paddingBottom: 6, borderBottom: '2px solid var(--ink)',
                }}>
                  <h3 style={{
                    margin: 0, fontFamily: 'var(--sans)', fontSize: 15, fontWeight: 600,
                    color: 'var(--ink)', letterSpacing: '-0.005em',
                  }}>{typeLabel(t)}</h3>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)',
                    letterSpacing: '0.12em', textTransform: 'uppercase',
                  }}>{groups[t].length}</span>
                </div>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))',
                  gap: 16,
                }}>
                  {groups[t].map((s, i) => <ScriptCard key={`${t}-${i}`} script={s} index={i + 1}
                    angleLookup={resultAngleLookup} />)}
                </div>
              </div>
            ))}
          </div>
        )
      })()}

      {/* History — previous draft scripts for this offer. Readable body
          previews, grouped by run-bucket (drafts created within the same
          minute = same fan-out run), collapsible per run. Replaces the
          old "Recent drafts" table whose titles were uninformative. */}
      {genTarget === 'scripts' && offerSlug && history.length > 0 && (() => {
        // Group rows into "runs": same script_type + same minute = one
        // bucket. We use script_type + minute since a single Generate fires
        // N calls per (angle × type), all stamped within seconds of each
        // other. Grouping by exact timestamp would split them up; grouping
        // by minute folds them cleanly without merging unrelated runs.
        const bucketKey = (r) => {
          const m = (r.created_at || '').slice(0, 16)  // YYYY-MM-DDTHH:MM
          return m
        }
        const buckets = {}
        const order = []
        for (const r of history) {
          const k = bucketKey(r)
          if (!buckets[k]) { buckets[k] = []; order.push(k) }
          buckets[k].push(r)
        }
        // angle slug -> angle row, so the History rows can show the angle name.
        // Build from the messagingLibrary if available (covers retired angles too
        // since History rows may reference angles that have since been retired)
        // and fall back to the active `angles` list.
        const angleLookup = buildAngleLookup([...(messagingLibrary || []), ...(angles || [])])
        return (
          <div style={{ marginTop: 48, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'baseline',
                          justifyContent: 'space-between', marginBottom: 12, gap: 12 }}>
              <div>
                <Eyebrow style={{ marginBottom: 4 }}>History · this offer</Eyebrow>
                <h2 style={{
                  margin: 0, fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400,
                }}>
                  {history.length} previously generated {history.length === 1 ? 'draft' : 'drafts'}
                </h2>
              </div>
              <button onClick={() => refreshHistory(offerSlug)} disabled={historyLoading}
                style={pillButtonStyle()}>
                {historyLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {order.map(k => (
                <HistoryRunRow key={k} bucket={k} rows={buckets[k]}
                  angleLookup={angleLookup}
                  currentOfferSlug={offerSlug} />
              ))}
            </div>
          </div>
        )
      })()}

      <ConfirmModal
        open={!!retireAngleTarget}
        onClose={() => !retireAngleBusy && setRetireAngleTarget(null)}
        onConfirm={performRetireAngle}
        title={`Retire "${retireAngleTarget?.name || 'this angle'}"?`}
        message="It will disappear from this library and from the Scripts > Angle picker. Historical scripts that reference it keep working — this is a soft delete (sets active = false)."
        confirmLabel="Retire angle"
        variant="danger"
        loading={retireAngleBusy}
      />
      <ConfirmModal
        open={bulkRetireOpen}
        onClose={() => !bulkRetireBusy && setBulkRetireOpen(false)}
        onConfirm={performBulkRetire}
        title={`Retire ${selectedAngleSlugs.size} ${selectedAngleSlugs.size === 1 ? 'angle' : 'angles'}?`}
        message={`All ${selectedAngleSlugs.size} selected angles will disappear from this library and from the Scripts > Angle picker. Historical scripts that reference them keep working — this is a soft delete (sets active = false on every selected row).`}
        confirmLabel={`Retire ${selectedAngleSlugs.size}`}
        variant="danger"
        loading={bulkRetireBusy}
      />
    </div>
  )
}

// Numbered step section — matches the SectionHead level="section" pattern
// (sans 18px h2 + mono eyebrow) but with the step number rendered as part
// of the eyebrow so the 4-step flow stays legible.
function Section({ label, title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <Eyebrow style={{ marginBottom: 6 }}>Step {label}</Eyebrow>
      <h2 style={{
        margin: 0, fontSize: 18, lineHeight: 1.2, color: 'var(--ink)',
        letterSpacing: '-0.005em', fontFamily: 'var(--sans)', fontWeight: 600,
        marginBottom: 14,
      }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

// Un-numbered section — same visual rhythm as Section but no "Step N"
// eyebrow. Used in the simplified /generate flow (Ben 2026-05-31) where
// numbered steps were reading like a tax form.
function Block({ eyebrow, title, children, hint, dense }) {
  return (
    <div style={{ marginBottom: dense ? 20 : 28 }}>
      {eyebrow && <Eyebrow style={{ marginBottom: 6 }}>{eyebrow}</Eyebrow>}
      {title && (
        <h2 style={{
          margin: 0, fontSize: dense ? 14 : 17, lineHeight: 1.2, color: 'var(--ink)',
          letterSpacing: '-0.005em', fontFamily: 'var(--sans)', fontWeight: 600,
          marginBottom: hint ? 6 : 12,
        }}>
          {title}
        </h2>
      )}
      {hint && (
        <p style={{ fontFamily: 'var(--serif)', fontSize: 13, fontStyle: 'italic',
                    color: 'var(--ink-4)', margin: '0 0 12px', maxWidth: 720, lineHeight: 1.5 }}>
          {hint}
        </p>
      )}
      {children}
    </div>
  )
}

// Collapsible "Advanced (optional)" block. Defaults closed; opens
// automatically when defaultOpen is true (e.g. the operator has set a
// non-default value in one of the contained fields). State is
// controlled-via-props so the parent can force-open it when it
// detects activity inside.
function AdvancedExpander({ label = 'Advanced (optional)', defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  // Sync open state when defaultOpen flips true — but never auto-close
  // on the operator (otherwise they'd lose their work mid-edit).
  useEffect(() => {
    if (defaultOpen && !open) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultOpen])
  return (
    <div style={{ marginTop: 28, marginBottom: 16,
                  border: '1px solid var(--rule)', background: 'var(--paper)',
                  borderRadius: 9 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '12px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>
        <span>{label}</span>
        {open
          ? <ChevronUp size={14} color="var(--ink-4)" />
          : <ChevronDown size={14} color="var(--ink-4)" />}
      </button>
      {open && (
        <div style={{ padding: '6px 18px 18px', borderTop: '1px solid var(--rule)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

// Pill-style mono button used for the angle-picker batch controls
// (Select all / Clear). Same shape used in MechanismConfigModal etc.
// Collapsible "run row" in the History block. One row per minute-bucket
// of generated_scripts. Default closed; expands to show the actual body
// previews for each draft inside the bucket. Replaces the old "Recent
// drafts" flat table whose titles were uninformative.
// Mode color palette — keep in sync with the Mode Mix Block. Per
// Schwartz stage:
//   direct      Stage 1-2 = warm gray ink
//   hybrid      Stage 2-3 = amber middle ground
//   educational Stage 3-4 = blue (where the conversion lift lives)
const SCRIPT_MODE_META = {
  direct:      { label: 'Direct',      color: '#5a6770', tint: '#eef1f3' },
  hybrid:      { label: 'Hybrid',      color: '#a87a1e', tint: '#fbf3df' },
  educational: { label: 'Educational', color: '#3068b5', tint: '#e8f0fb' },
}
function scriptModeMeta(m) {
  return SCRIPT_MODE_META[m] || { label: m || '—', color: 'var(--ink-4)', tint: 'transparent' }
}

// Lookup helper: angle slug → angle name + type. Passed down from the
// AdsGenerator parent so every row can show "for which angle this was
// generated" without an extra fetch per row.
function buildAngleLookup(angles) {
  const out = {}
  for (const a of angles || []) out[a.slug] = a
  return out
}

function HistoryRunRow({ bucket, rows, angleLookup, currentOfferSlug }) {
  const [open, setOpen] = useState(false)
  // Within a batch, group by ANGLE first (the most important context — Ben:
  // "I can't tell what these are for"), then by script type. So the operator
  // sees the angle name as a heading, then "Hook · 4", "Body · 3" beneath it.
  const byAngle = {}
  const angleOrder = []
  for (const r of rows) {
    const k = r.angle_slug || '_unknown'
    if (!byAngle[k]) { byAngle[k] = { rows: [], types: new Set(), modes: new Set() }; angleOrder.push(k) }
    byAngle[k].rows.push(r)
    if (r.script_type) byAngle[k].types.add(r.script_type)
    const m = r.target_attributes?.script_mode
    if (m) byAngle[k].modes.add(m)
  }
  // Batch-level summaries for the collapsed header
  const allTypes = {}
  const allModes = {}
  for (const r of rows) {
    const t = r.script_type || '—'
    allTypes[t] = (allTypes[t] || 0) + 1
    const m = r.target_attributes?.script_mode
    if (m) allModes[m] = (allModes[m] || 0) + 1
  }
  const ts = new Date(bucket + ':00Z')
  const when = isNaN(ts) ? bucket : ts.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--rule)',
      borderLeft: '3px solid var(--accent)', borderRadius: 9,
    }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '12px 16px', background: 'transparent',
          border: 'none', cursor: 'pointer', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-4)', minWidth: 110,
        }}>{when}</span>
        <span style={{
          fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 600, color: 'var(--ink)',
        }}>
          {rows.length} {rows.length === 1 ? 'draft' : 'drafts'}
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.06em',
          color: 'var(--ink-3)',
        }}>
          across {angleOrder.length} angle{angleOrder.length === 1 ? '' : 's'}
        </span>
        {/* Type counts as chips */}
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {Object.entries(allTypes).map(([t, n]) => (
            <span key={t} style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '2px 7px',
              background: 'var(--paper)', border: '1px solid var(--rule)',
              color: 'var(--ink-2)', borderRadius: 9,
            }}>
              {t} · {n}
            </span>
          ))}
        </span>
        {/* Mode counts as color-coded chips */}
        {Object.keys(allModes).length > 0 && (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {Object.entries(allModes).map(([m, n]) => {
              const mm = scriptModeMeta(m)
              return (
                <span key={m} style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '2px 7px',
                  background: mm.tint, border: `1px solid ${mm.color}`,
                  color: mm.color, borderRadius: 9, fontWeight: 600,
                }}>
                  {mm.label} · {n}
                </span>
              )
            })}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {open ? <ChevronUp size={14} color="var(--ink-4)" /> : <ChevronDown size={14} color="var(--ink-4)" />}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--rule)', padding: '14px 16px 16px', background: '#fafaf7' }}>
          {angleOrder.map(angleSlug => {
            const group = byAngle[angleSlug]
            const angle = angleLookup?.[angleSlug]
            const tMeta = angle ? angleTypeMeta(angle.angle_type) : { color: 'var(--rule)', label: '—' }
            // Within this angle, group by type so the operator sees Hooks then Bodies.
            const byType = {}
            const typeOrder = []
            for (const r of group.rows) {
              const t = r.script_type || '—'
              if (!byType[t]) { byType[t] = []; typeOrder.push(t) }
              byType[t].push(r)
            }
            return (
              <div key={angleSlug} style={{ marginBottom: 18 }}>
                {/* Angle heading — type-colored left bar so the operator
                    can scan problem/circumstance/outcome at a glance */}
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 10,
                  padding: '6px 0 8px 12px', marginBottom: 8,
                  borderLeft: `3px solid ${tMeta.color}`,
                  borderBottom: '1px solid var(--rule)',
                }}>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em',
                    textTransform: 'uppercase', fontWeight: 700,
                    color: tMeta.color,
                  }}>{tMeta.label}</span>
                  <span style={{
                    fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500,
                    color: 'var(--ink)', lineHeight: 1.25,
                  }}>{angle?.name || angleSlug}</span>
                  <span style={{
                    marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10,
                    letterSpacing: '0.08em', color: 'var(--ink-4)',
                  }}>
                    {group.rows.length} · {typeOrder.map(t => `${byType[t].length} ${t.toLowerCase()}`).join(' / ')}
                  </span>
                </div>
                {typeOrder.map(t => (
                  <div key={t} style={{ marginBottom: 14 }}>
                    <div style={{
                      fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.16em',
                      textTransform: 'uppercase', color: 'var(--ink-3)',
                      marginBottom: 8, fontWeight: 700,
                    }}>
                      {t} · {byType[t].length}
                    </div>
                    {/* Tile grid (Ben 2026-06-01 PM — "should be tile view
                        like when they really generate, not a list, they're
                        messy as a list"). Responsive auto-fill so 1-4
                        tiles per row depending on screen width. */}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                      gap: 12,
                    }}>
                      {byType[t].map(r => <HistoryDraftRow key={r.id} row={r} angle={angle} />)}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Tile-shaped draft card (Ben 2026-06-01 PM — list view was too messy,
// tile view like the post-gen output). Header: mode badge + shape +
// proof + word count. Body: teach-focus subtitle + clamped preview.
// Footer: status + copy. Click anywhere on the body opens a full-text
// modal so expanding doesn't disrupt the grid layout.
function HistoryDraftRow({ row, angle, angleName }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  // P1 fix from code review: Escape closes the modal + body scroll locks
  // while the modal's open so the page beneath doesn't scroll behind the
  // fixed overlay. Single effect, both behaviors, cleans up on unmount.
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setModalOpen(false) }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [modalOpen])
  const mode = row.target_attributes?.script_mode
  const modeMeta = scriptModeMeta(mode)
  const shape = row.target_attributes?.shape_code
  const proofChar = row.target_attributes?.proof_character
  const teachFocus = row.target_attributes?.teach_focus
  const wordCount = (row.body || '').trim().split(/\s+/).filter(Boolean).length
  const preview = (row.body || '').replace(/\s+/g, ' ').trim()
  // Resolve angle context — angle prop is the canonical input; angleName
  // is the legacy fallback so any old call site still gets a sensible
  // string. Without angle.angle_type we can't color-code the tag box.
  const resolvedAngleName = angle?.name || angleName || (row.angle_slug || '').replace(/^opt-[^-]+-(?:outcome|problem|circumstance|desire)-/, '').replace(/-/g, ' ')
  const angleTypeMetaResolved = angle ? angleTypeMeta(angle.angle_type) : null
  function copyBody(e) {
    e.stopPropagation()
    navigator.clipboard.writeText(row.body || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1100)
  }
  return (
    <>
      <div
        onClick={() => setModalOpen(true)}
        style={{
          position: 'relative',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderTop: mode ? `3px solid ${modeMeta.color}` : '3px solid var(--rule)',
          borderRadius: 9,
          padding: '12px 14px 10px',
          minHeight: 200,
          display: 'flex', flexDirection: 'column', gap: 8,
          cursor: 'pointer',
          transition: 'box-shadow 120ms ease, transform 120ms ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.boxShadow = `0 4px 12px rgba(26,36,44,0.08)`
          e.currentTarget.style.transform = 'translateY(-1px)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.boxShadow = 'none'
          e.currentTarget.style.transform = 'translateY(0)'
        }}
      >
        {/* Header row: mode badge + word count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {mode && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.14em',
              textTransform: 'uppercase', fontWeight: 700,
              padding: '3px 8px', background: modeMeta.tint, color: modeMeta.color,
              border: `1px solid ${modeMeta.color}`, borderRadius: 9,
            }}>{modeMeta.label}</span>
          )}
          {shape && (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--ink-3)',
              padding: '2px 7px', background: 'var(--paper)',
              border: '1px solid var(--rule)', borderRadius: 9,
            }}>{shape}</span>
          )}
          <span style={{
            marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10,
            color: 'var(--ink-4)', letterSpacing: '0.04em',
          }}>{wordCount}w</span>
        </div>

        {/* Angle tag box (Ben 2026-06-01 PM — "below the mode have what
            the angle is in a box, so I know what the script is for
            without referencing the section header above"). Color-coded
            by angle_type so it visually echoes the section heading bar. */}
        {resolvedAngleName && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 8px 6px 10px',
            background: angleTypeMetaResolved ? `${angleTypeMetaResolved.color}0d` : 'var(--paper)',
            border: `1px solid ${angleTypeMetaResolved ? angleTypeMetaResolved.color : 'var(--rule)'}`,
            borderLeft: `3px solid ${angleTypeMetaResolved ? angleTypeMetaResolved.color : 'var(--ink-3)'}`,
            borderRadius: 9,
          }}>
            {angleTypeMetaResolved && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em',
                textTransform: 'uppercase', fontWeight: 700,
                color: angleTypeMetaResolved.color, flexShrink: 0,
              }}>{angleTypeMetaResolved.label}</span>
            )}
            <span style={{
              fontFamily: 'var(--serif)', fontSize: 13, fontWeight: 500,
              color: 'var(--ink)', lineHeight: 1.3,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={resolvedAngleName}>{resolvedAngleName}</span>
          </div>
        )}

        {/* Proof character (when present) — italic serif, like the angle tile */}
        {proofChar && (
          <div style={{
            fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12.5,
            color: 'var(--ink-3)',
          }}>{proofChar}</div>
        )}

        {/* Teach focus (educational/hybrid only) */}
        {teachFocus && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.04em',
            color: 'var(--ink-3)', lineHeight: 1.35,
          }}>
            <span style={{ color: 'var(--ink-4)' }}>Teaches:</span>{' '}
            <span style={{ color: 'var(--ink-2)' }}>{teachFocus}</span>
          </div>
        )}

        {/* Preview body — clamped to ~6 lines via webkit line-clamp + plain CSS fallback */}
        <div style={{
          fontFamily: 'var(--serif)', fontSize: 13, lineHeight: 1.55,
          color: 'var(--ink-2)',
          flex: 1,
          display: '-webkit-box',
          WebkitLineClamp: 6,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}>
          {preview}
        </div>

        {/* Footer row: status + copy */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          paddingTop: 6, borderTop: '1px solid var(--rule)',
          marginTop: 'auto',
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 9.5,
            padding: '2px 6px', background: 'var(--paper)', border: '1px solid var(--rule)',
            color: 'var(--ink-4)', borderRadius: 9, letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>{row.status || 'draft'}</span>
          <span style={{
            marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5,
            color: 'var(--ink-4)', letterSpacing: '0.08em', textTransform: 'uppercase',
          }}>Click to read</span>
          <button onClick={copyBody} title="Copy script body"
            style={{
              padding: '4px 8px', background: copied ? 'var(--accent)' : 'transparent',
              border: '1px solid var(--rule)', color: 'var(--ink-3)',
              cursor: 'pointer', borderRadius: 9,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Full-text modal — opens on tile click. Themed, not a browser alert. */}
      {modalOpen && (
        <div
          onClick={() => setModalOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(26,36,44,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--paper)', borderRadius: 10,
              maxWidth: 720, width: '100%', maxHeight: '85vh',
              display: 'flex', flexDirection: 'column',
              borderTop: mode ? `4px solid ${modeMeta.color}` : '4px solid var(--ink)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{
              padding: '18px 22px',
              borderBottom: '1px solid var(--rule)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}>
              {mode && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em',
                  textTransform: 'uppercase', fontWeight: 700,
                  padding: '3px 8px', background: modeMeta.tint, color: modeMeta.color,
                  border: `1px solid ${modeMeta.color}`, borderRadius: 9,
                }}>{modeMeta.label}</span>
              )}
              {shape && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
                  textTransform: 'uppercase', color: 'var(--ink-3)',
                  padding: '2px 8px', background: 'var(--paper)',
                  border: '1px solid var(--rule)', borderRadius: 9,
                }}>Shape {shape}</span>
              )}
              {resolvedAngleName && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)',
                }}>
                  {angleTypeMetaResolved && (
                    <span style={{
                      fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em',
                      textTransform: 'uppercase', fontWeight: 700,
                      color: 'var(--paper)', background: angleTypeMetaResolved.color,
                      padding: '2px 6px', borderRadius: 9,
                    }}>{angleTypeMetaResolved.label}</span>
                  )}
                  {resolvedAngleName}
                </span>
              )}
              <span style={{
                marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10,
                color: 'var(--ink-4)', letterSpacing: '0.06em',
              }}>{wordCount} words</span>
              <button onClick={() => setModalOpen(false)} title="Close"
                style={{
                  padding: 6, background: 'transparent', border: '1px solid var(--rule)',
                  color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
                }}>
                <X size={14} />
              </button>
            </div>
            <div style={{
              padding: '20px 22px', overflow: 'auto', flex: 1,
              fontFamily: 'var(--serif)', fontSize: 15, lineHeight: 1.65,
              color: 'var(--ink-2)', whiteSpace: 'pre-wrap',
            }}>
              {row.body}
            </div>
            <div style={{
              padding: '14px 22px', borderTop: '1px solid var(--rule)',
              display: 'flex', alignItems: 'center', gap: 10, background: 'var(--paper)',
            }}>
              {teachFocus && (
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)',
                }}>Teaches: <span style={{ color: 'var(--ink-2)' }}>{teachFocus}</span></span>
              )}
              <button onClick={copyBody}
                style={{
                  marginLeft: 'auto',
                  padding: '8px 16px', fontFamily: 'var(--mono)', fontSize: 11,
                  letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 700,
                  background: copied ? 'var(--accent)' : 'var(--ink)',
                  color: copied ? 'var(--ink)' : 'var(--paper)',
                  border: 'none', cursor: 'pointer', borderRadius: 9,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy script</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Angle picker chip with hover popup + colored type accent + gear icon.
// Visual rules (Ben 2026-06-01):
//   - hover reveals a 3px left accent in the angle_type color (red for
//     problem, blue for desire)
//   - hover reveals a settings gear that opens the ProofCharacterEditor
//     for THIS angle (independent of multi-select state)
//   - if the angle has zero saved proofs, a tiny dot indicator shows on
//     the chip so the operator sees which need setup
//   - hover (after a ~200ms dwell) pops a themed card below the chip
//     with the angle's voice/qualifier/promise/mechanism. No browser
//     title tooltip — themed in-app popup per the UX rule.
function AngleChip({ angle, selected, proofCount, onToggle, onOpenProofs }) {
  const [hover, setHover] = useState(false)
  const [popOpen, setPopOpen] = useState(false)
  const dwellRef = useRef(null)

  const meta = angleTypeMeta(angle.angle_type)
  const typeColor = meta.color
  const typeLabel = meta.label
  const needsProofs = proofCount === 0

  function startHover() {
    setHover(true)
    clearTimeout(dwellRef.current)
    dwellRef.current = setTimeout(() => setPopOpen(true), 220)
  }
  function endHover() {
    setHover(false)
    setPopOpen(false)
    clearTimeout(dwellRef.current)
  }

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}
      onMouseEnter={startHover} onMouseLeave={endHover}>
      <div style={{
        display: 'inline-flex', alignItems: 'stretch',
        border: `2px solid ${selected ? 'var(--ink)' : 'var(--rule)'}`,
        borderLeft: `3px solid ${(hover || selected) ? typeColor : (selected ? 'var(--ink)' : 'var(--rule)')}`,
        background: selected ? 'var(--ink)' : 'var(--paper)',
        borderRadius: 9,
        transition: 'border-color 120ms ease',
      }}>
        <button onClick={onToggle}
          style={{
            padding: '10px 12px 10px 14px',
            background: 'transparent', border: 'none',
            color: selected ? 'var(--paper)' : 'var(--ink)',
            fontFamily: 'var(--sans)', fontSize: 14, fontWeight: selected ? 600 : 400,
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
          {selected && <Check size={14} />}
          {angle.name}
          {needsProofs && !selected && (
            <span title="No proof characters saved yet"
              style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#d68f00', display: 'inline-block', marginLeft: 2,
              }} />
          )}
        </button>
        {hover && (
          <button onClick={(e) => { e.stopPropagation(); onOpenProofs() }}
            title="Manage proof characters for this angle"
            style={{
              padding: '0 10px',
              background: selected ? 'var(--ink-3)' : 'var(--paper)',
              border: 'none',
              borderLeft: `1px solid ${selected ? 'var(--ink-3)' : 'var(--rule)'}`,
              color: selected ? 'var(--paper)' : 'var(--ink-3)',
              cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center',
            }}>
            <Settings size={13} />
          </button>
        )}
      </div>
      {popOpen && (
        <div style={{
          position: 'absolute', zIndex: 60,
          top: 'calc(100% + 6px)', left: 0,
          minWidth: 320, maxWidth: 420,
          padding: '12px 14px',
          background: 'var(--paper)',
          border: '1px solid var(--rule)',
          borderTop: `3px solid ${typeColor}`,
          borderRadius: 9,
          boxShadow: '0 16px 40px rgba(10,10,10,0.18)',
          fontFamily: 'var(--sans)', color: 'var(--ink-2)',
          pointerEvents: 'none',   // popup is read-only; lets mouse pass through
        }}>
          <div style={{
            display: 'inline-block', padding: '2px 7px', marginBottom: 8,
            background: typeColor, color: 'var(--paper)',
            fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase', borderRadius: 9,
          }}>{typeLabel}</div>
          {angle.prospect_voice && (
            <div style={{
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 13.5,
              color: 'var(--ink)', lineHeight: 1.5, marginBottom: 10,
            }}>"{angle.prospect_voice}"</div>
          )}
          {angle.qualifier && (
            <PopupRow label="Qualifier" value={angle.qualifier} />
          )}
          {angle.primary_promise && (
            <PopupRow label="Promise" value={angle.primary_promise} />
          )}
          {angle.mechanism_short && (
            <PopupRow label="Mechanism" value={angle.mechanism_short} />
          )}
          <div style={{
            marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
            color: 'var(--ink-4)', textTransform: 'uppercase',
          }}>
            {proofCount === null
              ? 'Proofs: loading…'
              : proofCount === 0
                ? 'Proofs: none yet — will auto-generate on Generate'
                : `Proofs: ${proofCount} saved`}
          </div>
        </div>
      )}
    </div>
  )
}

function PopupRow({ label, value }) {
  return (
    <div style={{ marginBottom: 6, fontSize: 12.5, lineHeight: 1.4 }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 6,
      }}>{label}:</span>
      <span style={{ fontFamily: 'var(--sans)', color: 'var(--ink-2)' }}>{value}</span>
    </div>
  )
}

// localStorage in-flight marker for Messaging generation. Survives
// component unmount + page refresh + navigation. The Edge Function
// auto-saves angles regardless, so this is purely a UI signal — the
// remount recovery effect polls the library and clears the marker once
// the new rows surface.
const MESSAGING_INFLIGHT_KEY = 'opt-ads-generate-messaging-inflight'
function saveMessagingInFlight(job) {
  try { localStorage.setItem(MESSAGING_INFLIGHT_KEY, JSON.stringify(job)) } catch {}
}
function readMessagingInFlight() {
  try {
    const raw = localStorage.getItem(MESSAGING_INFLIGHT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function clearMessagingInFlight() {
  try { localStorage.removeItem(MESSAGING_INFLIGHT_KEY) } catch {}
}

function pillButtonStyle() {
  return {
    padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
    letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
    border: '1px solid var(--rule)', background: 'transparent',
    color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
  }
}

// Reusable free-text instructions field shared between Messaging and Scripts.
// 6 rows by default — enough to type 2-3 specific asks without feeling cramped,
// vertical-resize via the textarea handle for longer instructions.
function ExtraInstructionsField({ value, onChange }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={6}
      placeholder={`e.g. "Lead with Eric's $215K close in 90 days"\n     "Don't mention guarantees in any hook"\n     "Bias toward roofers with weather-driven seasonality"\n\nLeave blank to use the default prompt.`}
      style={{
        width: '100%', maxWidth: 720, padding: '12px 14px',
        fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.5,
        border: '1px solid var(--rule)', background: 'var(--paper)',
        color: 'var(--ink)', resize: 'vertical', borderRadius: 9,
        outline: 'none',
      }}
      onFocus={(e) => e.currentTarget.style.borderColor = 'var(--ink-3)'}
      onBlur={(e) => e.currentTarget.style.borderColor = 'var(--rule)'}
    />
  )
}

function ModeCard({ selected, onClick, icon, title, desc }) {
  return (
    <button onClick={onClick}
      style={{
        flex: '1 1 280px', maxWidth: 400, padding: 20,
        paddingTop: selected ? 17 : 20,
        border: '1px solid var(--rule)',
        borderTop: selected ? '4px solid var(--accent)' : '1px solid var(--rule)',
        background: 'var(--paper)',
        cursor: 'pointer', textAlign: 'left',
        transition: 'border-color 140ms ease, background 140ms ease',
        position: 'relative',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ color: selected ? 'var(--ink)' : 'var(--ink-4)' }}>{icon}</span>
        <span style={{
          fontFamily: 'var(--sans)', fontSize: 15, fontWeight: 600, color: 'var(--ink)',
        }}>
          {title}
        </span>
        {selected && <Check size={16} color="var(--ink)" style={{ marginLeft: 'auto' }} />}
      </div>
      <p style={{ fontFamily: 'var(--sans)', fontSize: 13, color: 'var(--ink-3)',
                  margin: 0, lineHeight: 1.5 }}>
        {desc}
      </p>
    </button>
  )
}

// Card for a generated angle in Messaging mode. Renders the angle in
// the prospect's voice + the hook-build sketch + any pain points.
// Tag color follows the OPT palette via PALETTE in atoms.jsx.
function AngleCard({ angle }) {
  const meta = angleTypeMeta(angle.angle_type)
  const tagColor = meta.color
  const tagLabel = meta.label
  return (
    <div style={{
      padding: '18px 22px', background: 'var(--paper)',
      border: '1px solid var(--rule)', borderLeft: `4px solid ${tagColor}`,
      borderRadius: 9,
    }}>
      <div style={{
        display: 'inline-block', padding: '2px 8px', marginBottom: 10,
        background: tagColor, color: 'var(--paper)',
        fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
        letterSpacing: '0.14em', textTransform: 'uppercase',
        borderRadius: 9,
      }}>{tagLabel}</div>
      <h3 style={{
        margin: '0 0 8px', fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500,
        lineHeight: 1.25, color: 'var(--ink)',
      }}>{angle.name}</h3>
      <div style={{
        fontFamily: 'var(--serif)', fontSize: 15, fontStyle: 'italic',
        color: 'var(--ink-2)', lineHeight: 1.55, marginBottom: 12,
      }}>"{angle.prospect_voice}"</div>
      {angle.why_it_matters && (
        <AngleSubBlock label="Why it matters">
          <div style={{ fontFamily: 'var(--serif)', fontSize: 13.5,
                        color: 'var(--ink-2)', lineHeight: 1.55 }}>
            {angle.why_it_matters}
          </div>
        </AngleSubBlock>
      )}
      {angle.evidence_examples?.length > 0 && (
        <AngleSubBlock label="Evidence — concrete moments">
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--serif)',
                      fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            {angle.evidence_examples.map((ex, i) => <li key={i}>{ex}</li>)}
          </ul>
        </AngleSubBlock>
      )}
      {angle.hook_build_sketch && (
        <AngleSubBlock label="Hook build">
          <div style={{ fontFamily: 'var(--sans)', fontSize: 13,
                        color: 'var(--ink-2)', lineHeight: 1.5 }}>
            {angle.hook_build_sketch}
          </div>
        </AngleSubBlock>
      )}
      {angle.pain_points?.length > 0 && (
        <AngleSubBlock label="Pain points">
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--sans)',
                      fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
            {angle.pain_points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </AngleSubBlock>
      )}
      {angle.sources?.length > 0 && (
        <AngleSubBlock label={`Sources cited (${angle.sources.length})`}>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
            {angle.sources.map((s, i) => (
              <li key={i} style={{ marginBottom: 6, fontSize: 12.5, lineHeight: 1.45 }}>
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                  style={{ fontFamily: 'var(--sans)', color: 'var(--ink-2)',
                          textDecoration: 'underline', textDecorationColor: 'var(--rule)',
                          textUnderlineOffset: 2, fontWeight: 500 }}>
                  {s.title || s.url}
                </a>
                {s.relevance && (
                  <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic',
                                 color: 'var(--ink-4)', marginLeft: 6 }}>
                    — {s.relevance}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </AngleSubBlock>
      )}
    </div>
  )
}

// Generation progress feedback. The Edge Function is a single
// request/response so there's no real per-step signal — this is an
// elapsed-time + phase-cycler that gives the operator something to read
// while Claude runs (60–120s for a normal batch). Phases are tailored
// per `kind` so it reads correctly for hooks / bodies / joined / angles.
function GenProgress({ kind, total, fanout }) {
  const [elapsed, setElapsed] = useState(0)
  const [phaseIdx, setPhaseIdx] = useState(0)

  const phases = useMemo(() => {
    if (kind === 'angles') {
      return [
        `Searching the web for real grounding sources`,
        `Drafting ${total} angles in the prospect's voice`,
        `Adding why-it-matters + concrete evidence per angle`,
        `Saving to the offer's angle library`,
      ]
    }
    if (kind === 'bodies') {
      return [
        `Loading angle, mechanism, and proof characters`,
        `Drafting ${total} bodies against the 7-beat skeleton`,
        `Reviewing for voice + banned-phrase compliance`,
        `Saving drafts`,
      ]
    }
    if (kind === 'joined') {
      return [
        `Loading angle, hook shapes, and body skeleton`,
        `Drafting ${total} hooks, then continuing each into its body`,
        `Reviewing chained scripts for proof-character continuity`,
        `Saving drafts`,
      ]
    }
    if (kind === 'mixed') {
      return [
        `Loading angles, mechanisms, proofs in parallel`,
        `Drafting ${total} scripts across types`,
        `Reviewing each batch for voice + skeleton compliance`,
        `Saving drafts`,
      ]
    }
    // hooks (default)
    return [
      `Loading angle + hook shapes`,
      `Drafting ${total} hooks across the selected shapes`,
      `Reviewing for voice + banned-phrase compliance`,
      `Saving drafts`,
    ]
  }, [kind, total])

  useEffect(() => {
    const startedAt = Date.now()
    const id = setInterval(() => {
      const secs = Math.floor((Date.now() - startedAt) / 1000)
      setElapsed(secs)
      const expected = Math.max(30, 8 + total * 4)
      const ratio = Math.min(0.99, secs / expected)
      const idx = ratio < 0.15 ? 0 : ratio < 0.45 ? 1 : ratio < 0.85 ? 2 : 3
      setPhaseIdx(Math.min(idx, phases.length - 1))
    }, 500)
    return () => clearInterval(id)
  }, [total, phases.length])

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  // Fan-out progress bar (when multiple parallel calls in flight).
  // We show real done/total counts from the parent, plus an inline phase
  // hint for the proof-gen pre-step when applicable.
  const fanoutTotal = fanout?.total ?? 0
  const fanoutDone = fanout?.done ?? 0
  const fanoutFailed = fanout?.failed ?? 0
  const fanoutPhase = fanout?.phase  // 'proofs' | 'scripts' | undefined
  const fanoutPct = fanoutTotal > 0 ? Math.round((fanoutDone + fanoutFailed) * 100 / fanoutTotal) : 0

  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--paper)', border: '1px solid var(--rule)',
      borderLeft: '3px solid var(--accent)',
      borderRadius: 9,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{
          display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
          background: 'var(--ink)', animation: 'pulse 1s ease-in-out infinite',
        }} />
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: 'var(--ink-3)', fontWeight: 600,
        }}>
          {fanoutPhase === 'proofs'
            ? `Generating proof characters · ${fanoutDone}/${fanoutTotal}`
            : `Step ${phaseIdx + 1} of ${phases.length}`}
        </span>
        <span style={{
          marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--ink-4)', fontVariantNumeric: 'tabular-nums',
        }}>{mm}:{ss}</span>
      </div>
      <div style={{
        fontFamily: 'var(--serif)', fontSize: 14, color: 'var(--ink-2)',
        lineHeight: 1.4,
      }}>
        {fanoutPhase === 'proofs'
          ? `Auto-generating proof characters for angles that don't have any yet`
          : phases[phaseIdx]}
        <span style={{ display: 'inline-block', width: 16, color: 'var(--ink-4)' }}>
          {'.'.repeat((elapsed % 3) + 1)}
        </span>
      </div>
      {/* Fan-out bar — real per-call progress */}
      {fanout && fanoutTotal > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{
            height: 4, background: 'var(--rule)', borderRadius: 9, overflow: 'hidden',
          }}>
            <div style={{
              width: `${fanoutPct}%`, height: '100%',
              background: fanoutFailed ? 'var(--down)' : 'var(--ink)',
              transition: 'width 240ms ease',
            }} />
          </div>
          <div style={{
            marginTop: 4, fontFamily: 'var(--mono)', fontSize: 10.5,
            color: 'var(--ink-4)', letterSpacing: '0.06em',
          }}>
            {fanoutDone}/{fanoutTotal} batches complete{fanoutFailed ? ` · ${fanoutFailed} failed` : ''}
          </div>
        </div>
      )}
      <div style={{
        marginTop: 8, fontFamily: 'var(--serif)', fontSize: 11.5, fontStyle: 'italic',
        color: 'var(--ink-4)', lineHeight: 1.4,
      }}>
        {fanout && fanoutTotal > 1
          ? `Fanning out ${fanoutTotal} parallel Claude calls — phases above are estimated; the progress bar is real.`
          : `Claude runs the whole batch in one pass — phases are an estimate, not a real-time signal. A ${total}-item batch usually finishes in ${Math.round((8 + total * 4) / 6) * 6}–${Math.round((8 + total * 4) / 6) * 6 + 30}s. Safe to navigate away — angles auto-save to the library and a recovery banner will surface them when you come back.`}
      </div>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </div>
  )
}

// Inline quick-add for proofs on the Scripts tab. Lives under the
// "Will pull proofs from" preview. Lets the operator type a Proof N + type
// + result and attach it to a single selected angle without opening the
// full ProofCharacterEditor modal. For multi-angle selection, an "Attach
// to" dropdown picks which angle receives the new proof.
function InlineProofAdder({ angleSlugs, angles, onAdded }) {
  const [open, setOpen] = useState(false)
  const [targetSlug, setTargetSlug] = useState(angleSlugs[0] || '')
  const [proofType, setProofType] = useState('case_study')
  const [name, setName] = useState('')
  const [result, setResult] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [okMsg, setOkMsg] = useState(null)

  // Keep targetSlug in sync if the selected angles change.
  useEffect(() => {
    if (!angleSlugs.includes(targetSlug)) setTargetSlug(angleSlugs[0] || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angleSlugs.join('|')])

  const typeMeta = PROOF_TYPES_LOCAL.find(t => t.value === proofType) || PROOF_TYPES_LOCAL[0]

  async function save() {
    if (!targetSlug) { setErr('Pick an angle to attach to'); return }
    if (!name.trim() || !result.trim()) { setErr('Name and result are required'); return }
    setSaving(true); setErr(null); setOkMsg(null)
    try {
      await upsertProofCharacterCall({
        angle_slug: targetSlug,
        name: name.trim(),
        result_short: result.trim(),
        proof_type: proofType,
      })
      const angleName = angles.find(a => a.slug === targetSlug)?.name || targetSlug
      setOkMsg(`Saved "${name.trim()}" to ${angleName}`)
      setName(''); setResult('')
      onAdded?.(targetSlug)
      setTimeout(() => setOkMsg(null), 2500)
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--rule)' }}>
      {!open ? (
        <button onClick={() => setOpen(true)}
          style={{
            padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10.5,
            letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
            border: '1px dashed var(--ink-3)', background: 'transparent',
            color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <Plus size={12} /> Add a proof inline
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: 'var(--ink-3)',
            }}>Attach to</span>
            <select value={targetSlug} onChange={e => setTargetSlug(e.target.value)}
              style={inlineSelectStyle}>
              {angleSlugs.map(s => {
                const a = angles.find(x => x.slug === s)
                return <option key={s} value={s}>{a?.name || s}</option>
              })}
            </select>
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em',
              textTransform: 'uppercase', color: 'var(--ink-3)',
            }}>·</span>
            <select value={proofType} onChange={e => setProofType(e.target.value)}
              style={inlineSelectStyle}>
              {PROOF_TYPES_LOCAL.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <span style={{
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 11.5,
              color: 'var(--ink-4)',
            }}>{typeMeta.hint}</span>
            <button onClick={() => setOpen(false)}
              title="Close inline adder"
              style={{
                marginLeft: 'auto', padding: 4, background: 'transparent',
                border: 'none', color: 'var(--ink-4)', cursor: 'pointer',
              }}>
              <X size={13} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr auto', gap: 8 }}>
            <input type="text" value={name} placeholder={typeMeta.namePh}
              onChange={e => setName(e.target.value)} style={inlineInputStyle} />
            <input type="text" value={result} placeholder={typeMeta.resultPh}
              onChange={e => setResult(e.target.value)} style={inlineInputStyle}
              onKeyDown={(e) => { if (e.key === 'Enter' && !saving) save() }} />
            <button onClick={save} disabled={saving || !name.trim() || !result.trim()}
              style={{
                padding: '8px 14px', fontFamily: 'var(--mono)', fontSize: 11,
                letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
                border: '1px solid var(--ink)',
                background: (!name.trim() || !result.trim() || saving) ? 'var(--rule)' : 'var(--ink)',
                color: (!name.trim() || !result.trim() || saving) ? 'var(--ink-4)' : 'var(--paper)',
                cursor: (saving || !name.trim() || !result.trim()) ? 'not-allowed' : 'pointer',
                borderRadius: 9, display: 'inline-flex', alignItems: 'center', gap: 5,
              }}>
              {saving ? '...' : <><Plus size={12} /> Add</>}
            </button>
          </div>
          {err && (
            <div style={{
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12,
              color: 'var(--down)',
            }}>{err}</div>
          )}
          {okMsg && (
            <div style={{
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12,
              color: '#2f5f33',
            }}>{okMsg}</div>
          )}
        </div>
      )}
    </div>
  )
}

// Local catalog of proof types with placeholders — used by the inline
// adder. Mirrors the service's PROOF_TYPES + adds namePh / resultPh
// (which the editor modal generates inline; we duplicate here to keep
// this component self-contained).
const PROOF_TYPES_LOCAL = [
  { value: 'case_study',    label: 'Case study',    hint: 'Named client + result',
    namePh: 'Eric',                      resultPh: 'Closed a $215K job in 90 days' },
  { value: 'testimonial',   label: 'Testimonial',   hint: 'Direct quote',
    namePh: 'Mark — plumber, NC',        resultPh: '"My closing rate doubled in week 2."' },
  { value: 'statistic',     label: 'Statistic',     hint: 'Numeric data point',
    namePh: 'HomeAdvisor burnout rate',  resultPh: '67% of restoration owners burn out on it in year 2' },
  { value: 'authority',     label: 'Authority',     hint: 'Industry / institution citation',
    namePh: 'Roto-Rooter franchise manual', resultPh: 'Explicitly recommends abandoning shared-lead platforms' },
  { value: 'demonstration', label: 'Demonstration', hint: 'Before / after, show-not-tell',
    namePh: 'Month 1 vs month 6 dashboard', resultPh: '$14K → $48K MRR by month 6, charted' },
  { value: 'social_volume', label: 'Social volume', hint: 'Aggregate-count proof',
    namePh: 'Restoration cohort 2024',   resultPh: '38 companies, average $32K/mo lift' },
  { value: 'comparison',    label: 'Comparison',    hint: 'Vs alternative',
    namePh: 'vs HomeAdvisor',            resultPh: '3.2x bookings, 1/4 the cost-per-lead' },
]

const inlineSelectStyle = {
  padding: '5px 8px', fontFamily: 'var(--mono)', fontSize: 10.5,
  letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600,
  border: '1px solid var(--rule)', background: 'var(--paper)',
  color: 'var(--ink)', borderRadius: 9, outline: 'none', cursor: 'pointer',
}
const inlineInputStyle = {
  width: '100%', padding: '8px 10px',
  fontFamily: 'var(--sans)', fontSize: 13,
  border: '1px solid var(--rule)', background: 'var(--paper)',
  color: 'var(--ink)', borderRadius: 9, outline: 'none',
}

// Thin wrapper around upsertProofCharacter so this component doesn't
// have to import from a service that's already imported at the top of
// the file (keeps the InlineProofAdder colocated + readable).
async function upsertProofCharacterCall(payload) {
  const { upsertProofCharacter } = await import('../../services/scriptGenerator')
  return upsertProofCharacter(payload)
}

// Cluster view (Ben 2026-06-01) — groups angles by normalized name so
// duplicate clusters surface visually. "Hit Six Figures Monthly" + "Just
// Crossed $100K Monthly Revenue" end up in the same group with a single
// "select all 2 in cluster" button. Clusters of 1 are listed below in a
// "uniques" section so nothing hides. Same tile component, just grouped.
function LibraryClusterView({ angles, proofs, selected, onToggleSelect, onSelectCluster, onRetire, onOpenProofs, onEdit }) {
  // Group by angle_type first, then by normalized name fingerprint.
  // Normalize strips noise words (the, a, my, just, restoration, water, etc.)
  // and punctuation, keeping the first 3 meaningful tokens as the cluster
  // key. This matches roughly what a human sees as "the same idea."
  function normalize(s) {
    let out = (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    const stop = new Set([
      'the','a','an','just','my','me','i','and','or','of','for','in','on','with','to',
      'restoration','company','companies','damage','water','fire','mold','business',
      'biggest','major','monthly','per','month','authority','dominance','status',
      'position','leader','recently','currently',
    ])
    out = out.split(/\s+/).filter(w => w && !stop.has(w)).join(' ')
    return out
  }
  const byType = {}
  for (const a of angles) {
    const t = a.angle_type || 'other'
    if (!byType[t]) byType[t] = []
    byType[t].push(a)
  }
  const ORDER = ['problem', 'circumstance', 'outcome', 'desire', 'other']
  return (
    <div>
      {ORDER.filter(t => byType[t]).map(t => {
        const meta = angleTypeMeta(t)
        const items = byType[t]
        const clusters = {}
        for (const a of items) {
          const key = normalize(a.name).split(' ').slice(0, 3).join(' ') || '_blank'
          if (!clusters[key]) clusters[key] = []
          clusters[key].push(a)
        }
        const dupClusters = Object.entries(clusters).filter(([_, v]) => v.length > 1)
          .sort(([, a], [, b]) => b.length - a.length)
        const singles = Object.values(clusters).filter(v => v.length === 1).flat()
        return (
          <div key={t} style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{
                display: 'inline-block', padding: '3px 8px',
                background: meta.color, color: 'var(--paper)',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.14em', textTransform: 'uppercase', borderRadius: 9,
              }}>{meta.label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.06em' }}>
                {items.length} total · {dupClusters.length} duplicate cluster{dupClusters.length === 1 ? '' : 's'} · {singles.length} unique
              </span>
            </div>
            {dupClusters.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {dupClusters.map(([key, group]) => {
                  const allSelected = group.every(a => selected.has(a.slug))
                  return (
                    <div key={key} style={{
                      marginBottom: 14, padding: 12, background: '#fef6e6',
                      border: '1px solid #e8c98a', borderRadius: 9,
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        gap: 10, marginBottom: 10, flexWrap: 'wrap',
                      }}>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#7a5810', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700 }}>
                          Likely duplicates · {group.length} angles · "{key}"
                        </div>
                        <button
                          onClick={() => onSelectCluster(group.map(a => a.slug))}
                          disabled={allSelected}
                          style={{
                            padding: '4px 10px', fontFamily: 'var(--mono)', fontSize: 10,
                            letterSpacing: '0.12em', textTransform: 'uppercase',
                            background: allSelected ? '#e8c98a' : 'var(--paper)',
                            color: '#7a5810', border: '1px solid #7a5810',
                            cursor: allSelected ? 'default' : 'pointer', borderRadius: 9,
                            opacity: allSelected ? 0.7 : 1,
                          }}>
                          {allSelected ? '✓ All in cluster selected' : `Select all ${group.length}`}
                        </button>
                      </div>
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                        gap: 10,
                      }}>
                        {group.map(a => (
                          <LibraryAngleTile key={a.slug} angle={a}
                            proofs={proofs[a.slug] || []}
                            selected={selected.has(a.slug)}
                            onToggleSelect={() => onToggleSelect(a.slug)}
                            onRetire={() => onRetire(a)}
                            onOpenProofs={() => onOpenProofs(a)}
                            onEdit={onEdit ? () => onEdit(a) : undefined}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {singles.length > 0 && (
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-4)', letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 8 }}>
                  Uniques ({singles.length})
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                  gap: 10,
                }}>
                  {singles.map(a => (
                    <LibraryAngleTile key={a.slug} angle={a}
                      proofs={proofs[a.slug] || []}
                      selected={selected.has(a.slug)}
                      onToggleSelect={() => onToggleSelect(a.slug)}
                      onRetire={() => onRetire(a)}
                      onOpenProofs={() => onOpenProofs(a)}
                      onEdit={onEdit ? () => onEdit(a) : undefined}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Tile view for the Messaging "Saved for this offer" library. Rendered
// in a responsive grid (vs the old single-column thin-row pattern that
// Ben hated). Big serif title, type tag, prospect voice, proof type
// breakdown chips, and an expander for evidence_examples / why-it-matters.
// Retire = soft-delete (active=false).
function LibraryAngleTile({ angle, proofs, selected, onToggleSelect, onRetire, onOpenProofs, onEdit }) {
  const [open, setOpen] = useState(false)
  const meta = angleTypeMeta(angle.angle_type)
  const typeColor = meta.color
  const typeLabel = meta.label
  // Proof breakdown by type — used for the small footer chip row.
  const byType = {}
  for (const p of proofs) {
    const t = p.proof_type || 'case_study'
    byType[t] = (byType[t] || 0) + 1
  }
  const proofTypes = Object.keys(byType)
  return (
    <div style={{
      position: 'relative',
      background: 'var(--paper)',
      border: `1px solid ${selected ? '#1a242c' : 'var(--rule)'}`,
      borderTop: `3px solid ${typeColor}`, borderRadius: 9,
      padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
      boxShadow: selected ? '0 0 0 2px #1a242c inset, 0 2px 8px rgba(26,36,44,0.18)' : 'none',
      transition: 'box-shadow 120ms ease',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1, minWidth: 0 }}>
          {onToggleSelect && (
            <label title={selected ? 'Deselect' : 'Select for bulk retire'}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, marginTop: 4, flexShrink: 0,
                border: `1.5px solid ${selected ? '#1a242c' : 'var(--rule)'}`,
                background: selected ? '#1a242c' : 'var(--paper)',
                borderRadius: 9, cursor: 'pointer',
                transition: 'all 100ms ease',
              }}>
              <input
                type="checkbox"
                checked={!!selected}
                onChange={onToggleSelect}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer', margin: 0 }}
              />
              {selected && (
                <Check size={14} color="white" strokeWidth={3} />
              )}
            </label>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{
              display: 'inline-block', padding: '2px 7px', marginBottom: 6,
              background: typeColor, color: 'var(--paper)',
              fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase', borderRadius: 9,
            }}>{typeLabel}</span>
            <h3 style={{
              margin: 0, fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500,
              lineHeight: 1.25, color: 'var(--ink)', letterSpacing: '-0.005em',
            }}>{angle.name}</h3>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={onOpenProofs} title="Manage proof characters"
            style={{
              padding: 6, background: 'transparent', border: '1px solid var(--rule)',
              color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
            }}>
            <Settings size={13} />
          </button>
          {onEdit && (
            <button onClick={onEdit} title="Edit angle (qualifier, name, mechanism)"
              style={{
                padding: 6, background: 'transparent', border: '1px solid var(--rule)',
                color: 'var(--ink-3)', cursor: 'pointer', borderRadius: 9,
              }}>
              <Edit3 size={13} />
            </button>
          )}
          <button onClick={onRetire} title="Retire angle"
            style={{
              padding: 6, background: 'transparent', border: '1px solid var(--rule)',
              color: 'var(--ink-4)', cursor: 'pointer', borderRadius: 9,
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = 'var(--down)'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-4)'}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {angle.prospect_voice && (
        <div style={{
          fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 14,
          color: 'var(--ink-2)', lineHeight: 1.55,
        }}>"{angle.prospect_voice}"</div>
      )}
      {open && (
        <>
          {angle.why_it_matters && (
            <AngleSubBlock label="Why it matters">
              <div style={{ fontFamily: 'var(--serif)', fontSize: 13,
                            color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {angle.why_it_matters}
              </div>
            </AngleSubBlock>
          )}
          {angle.evidence_examples?.length > 0 && (
            <AngleSubBlock label="Evidence">
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--serif)',
                          fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {angle.evidence_examples.map((ex, i) => <li key={i}>{ex}</li>)}
              </ul>
            </AngleSubBlock>
          )}
          {angle.hook_build_sketch && (
            <AngleSubBlock label="Hook build">
              <div style={{ fontFamily: 'var(--sans)', fontSize: 13,
                            color: 'var(--ink-2)', lineHeight: 1.5 }}>
                {angle.hook_build_sketch}
              </div>
            </AngleSubBlock>
          )}
          {angle.pain_points?.length > 0 && (
            <AngleSubBlock label="Pain points">
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--sans)',
                          fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                {angle.pain_points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </AngleSubBlock>
          )}
        </>
      )}
      {/* Footer: proof breakdown + expander */}
      <div style={{
        marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--rule)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
          {proofTypes.length === 0 ? (
            <span style={{
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: '#7a5810',
              padding: '2px 8px', background: '#fef6e6', border: '1px solid #e8c98a',
              borderRadius: 9,
            }}>No proofs yet</span>
          ) : (
            proofTypes.map(t => (
              <span key={t} style={{
                fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--ink-2)',
                padding: '2px 7px', background: 'var(--paper)',
                border: '1px solid var(--rule)', borderRadius: 9,
              }}>
                {t.replace('_', ' ')} <span style={{ opacity: 0.6, marginLeft: 2 }}>×{byType[t]}</span>
              </span>
            ))
          )}
        </div>
        <button onClick={() => setOpen(o => !o)}
          style={{
            padding: '4px 8px', background: 'transparent', border: 'none',
            color: 'var(--ink-4)', cursor: 'pointer', fontFamily: 'var(--mono)',
            fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
          {open ? <>Less <ChevronUp size={12} /></> : <>More <ChevronDown size={12} /></>}
        </button>
      </div>
    </div>
  )
}

// Single row in the "Saved for this offer" list (Messaging tab). LEGACY —
// kept for reference; the Messaging tab now uses LibraryAngleTile in a
// grid. Will get removed once nothing else references it.
function SavedAngleRow({ angle, onRetire }) {
  const [open, setOpen] = useState(false)
  const meta = angleTypeMeta(angle.angle_type)
  const tagColor = meta.color
  const tagLabel = meta.label
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--rule)',
      borderLeft: `3px solid ${tagColor}`, borderRadius: 9,
    }}>
      <div style={{
        padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
        cursor: 'pointer',
      }} onClick={() => setOpen(o => !o)}>
        <span style={{
          padding: '2px 7px', background: tagColor, color: 'var(--paper)',
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase', borderRadius: 9,
          flexShrink: 0,
        }}>{tagLabel}</span>
        <span style={{
          flex: 1, fontFamily: 'var(--serif)', fontSize: 15, color: 'var(--ink)',
          lineHeight: 1.3,
        }}>{angle.name}</span>
        <button onClick={(e) => { e.stopPropagation(); onRetire() }}
          title="Retire (hide from picker)"
          style={{
            padding: 6, background: 'transparent', border: 'none',
            color: 'var(--ink-4)', cursor: 'pointer', borderRadius: 9,
            display: 'inline-flex',
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--down)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--ink-4)'}>
          <Trash2 size={14} />
        </button>
        {open ? <ChevronUp size={14} color="var(--ink-4)" /> : <ChevronDown size={14} color="var(--ink-4)" />}
      </div>
      {open && (
        <div style={{ padding: '0 16px 14px 16px' }}>
          {angle.prospect_voice && (
            <div style={{
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 14,
              color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 10,
            }}>"{angle.prospect_voice}"</div>
          )}
          {angle.why_it_matters && (
            <AngleSubBlock label="Why it matters">
              <div style={{ fontFamily: 'var(--serif)', fontSize: 13.5,
                            color: 'var(--ink-2)', lineHeight: 1.55 }}>
                {angle.why_it_matters}
              </div>
            </AngleSubBlock>
          )}
          {angle.evidence_examples?.length > 0 && (
            <AngleSubBlock label="Evidence — concrete moments">
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--serif)',
                          fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                {angle.evidence_examples.map((ex, i) => <li key={i}>{ex}</li>)}
              </ul>
            </AngleSubBlock>
          )}
          {angle.hook_build_sketch && (
            <AngleSubBlock label="Hook build">
              <div style={{ fontFamily: 'var(--sans)', fontSize: 13,
                            color: 'var(--ink-2)', lineHeight: 1.5 }}>
                {angle.hook_build_sketch}
              </div>
            </AngleSubBlock>
          )}
          {angle.pain_points?.length > 0 && (
            <AngleSubBlock label="Pain points">
              <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--sans)',
                          fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                {angle.pain_points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </AngleSubBlock>
          )}
          {angle.sources?.length > 0 && (
            <AngleSubBlock label={`Sources cited (${angle.sources.length})`}>
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {angle.sources.map((s, i) => (
                  <li key={i} style={{ marginBottom: 6, fontSize: 12.5, lineHeight: 1.45 }}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer"
                      style={{ fontFamily: 'var(--sans)', color: 'var(--ink-2)',
                              textDecoration: 'underline', textDecorationColor: 'var(--rule)',
                              textUnderlineOffset: 2, fontWeight: 500 }}>
                      {s.title || s.url}
                    </a>
                    {s.relevance && (
                      <span style={{ fontFamily: 'var(--sans)', fontStyle: 'italic',
                                     color: 'var(--ink-4)', marginLeft: 6 }}>
                        — {s.relevance}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </AngleSubBlock>
          )}
        </div>
      )}
    </div>
  )
}

// Small label-body subblock used inside SavedAngleRow + AngleCard.
// Keeps the mono eyebrow / serif body pairing consistent across both.
function AngleSubBlock({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '0.12em',
        textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 4,
      }}>{label}</div>
      {children}
    </div>
  )
}

// Result-panel tile. Header makes the ANGLE + MODE the dominant visual
// (Ben 2026-06-01 PM — "when it generates these, I need a clear
// understanding of what it actually is that the angle is targeting").
// The angle name is the primary heading in serif; angle-type colored
// pill + mode badge sit alongside; index + frame are subordinate.
function ScriptCard({ script, index, angleLookup }) {
  const [copied, setCopied] = useState(false)

  function copyBody() {
    navigator.clipboard.writeText(script.body || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Frame color preserved as a thin top stripe (PROBLEM=red, CIRC=amber,
  // OUTCOME=green) so the operator can scan the message-frame variety
  // across a deck even without reading the angle name.
  const frameColor = {
    PROBLEM: 'var(--down)',
    CIRCUMSTANCE: '#e0a93e',
    OUTCOME: 'var(--up)',
  }[script.frame] || 'var(--ink-4)'

  const angleSlug = script._combo?.angle_slug
  const angle = angleSlug ? angleLookup?.[angleSlug] : null
  const angleName = angle?.name || script.title || '—'
  const angleTypeMetaResolved = angle ? angleTypeMeta(angle.angle_type) : null
  const mode = script._combo?.script_mode
  const modeMeta = mode ? scriptModeMeta(mode) : null

  return (
    <div style={{ padding: 20, background: 'var(--paper)', border: '1px solid var(--rule)',
                  position: 'relative', borderRadius: 9 }}>
      {/* Top stripe — frame color */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3,
                    background: frameColor }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                    marginBottom: 12, marginTop: 4, gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* TAG ROW — angle type pill (color-coded) + mode badge (color-coded)
              + #index + length. Most important visual signal on the card. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {angleTypeMetaResolved && (
              <span style={{
                display: 'inline-block',
                padding: '3px 8px',
                background: angleTypeMetaResolved.color, color: 'var(--paper)',
                fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                letterSpacing: '0.14em', textTransform: 'uppercase', borderRadius: 9,
              }}>{angleTypeMetaResolved.label}</span>
            )}
            {modeMeta && (
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.14em',
                textTransform: 'uppercase', fontWeight: 700,
                padding: '3px 8px', background: modeMeta.tint, color: modeMeta.color,
                border: `1px solid ${modeMeta.color}`, borderRadius: 9,
              }}>{modeMeta.label}</span>
            )}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                          color: 'var(--ink-4)', letterSpacing: '0.08em' }}>
              #{String(index).padStart(2, '0')}
            </span>
            {script.length_bucket && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ink-4)',
                            letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                · {script.length_bucket.replace('_', ' ')}
              </span>
            )}
          </div>
          {/* ANGLE NAME — the primary readable heading. */}
          <div style={{ fontFamily: 'var(--serif)', fontSize: 19, color: 'var(--ink)',
                        fontWeight: 500, lineHeight: 1.25, letterSpacing: '-0.005em' }}>
            {angleName}
          </div>
          {/* Angle voice / qualifier — small hint of WHAT this angle promises
              so the operator doesn't have to remember it from the picker. */}
          {angle?.prospect_voice && (
            <div style={{
              marginTop: 4,
              fontFamily: 'var(--sans)', fontStyle: 'italic', fontSize: 12.5,
              color: 'var(--ink-3)', lineHeight: 1.45,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>"{angle.prospect_voice}"</div>
          )}
        </div>
        <button onClick={copyBody}
          style={{ padding: '6px 12px', fontFamily: 'var(--mono)', fontSize: 10,
                  letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
                  border: `1px solid ${copied ? 'var(--accent)' : 'var(--rule)'}`,
                  background: copied ? 'var(--accent)' : 'var(--paper)',
                  color: 'var(--ink)', cursor: 'pointer', borderRadius: 9,
                  flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      {/* Attribute pills — proof character is the key one; others kept as
          secondary hints since the angle + mode badges above carry the
          primary signal now. */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
        {[
          ['proof', script.proof_character || script.target_attributes?.proof_character],
          ['hook', script.hook_type],
          ['mech', script.mechanism_reveal],
          ['stage', script.funnel_stage],
        ].filter(([_, v]) => v && v !== 'none').map(([k, v]) => (
          <span key={k} style={{ padding: '3px 7px', background: 'var(--paper)',
                                fontFamily: 'var(--mono)', fontSize: 10,
                                letterSpacing: '0.04em', color: 'var(--ink-3)',
                                border: '1px solid var(--rule)', borderRadius: 9 }}>
            <span style={{ color: 'var(--ink-4)' }}>{k}</span>:&nbsp;
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>{v}</span>
          </span>
        ))}
      </div>

      <div style={{ fontFamily: 'var(--sans)', fontSize: 14, lineHeight: 1.55,
                    color: 'var(--ink)', whiteSpace: 'pre-wrap',
                    paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
        {script.body}
      </div>
    </div>
  )
}
