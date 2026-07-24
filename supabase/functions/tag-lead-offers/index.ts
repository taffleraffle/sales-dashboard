// tag-lead-offers — decides which OFFER a GHL lead opted into (trial vs
// map-stacking) from their Meta ad attribution, then tags the contact and
// drops a note ("comment on the lead"). Everything downstream — the calendar
// rename (T1/M1) and the Slack close-routing (#new-trials / #new-map-stacks) —
// reads that one tag instead of re-deriving the offer.
//
//   POST /functions/v1/tag-lead-offers
//     {}                    -> batch: process recent contacts (last `minutes`)
//     { minutes: 240 }      -> batch with a custom look-back window
//     { contactId: "abc" }  -> single contact (for a GHL workflow / Zap trigger)
//     { dryRun: true }      -> detect + report, write NOTHING (safe preview)
//
// ─── FOR BEN TO CONFIRM — naming lives in exactly two places ──────────────────
//   1) OFFERS below           — the tag names, the calendar codes, note labels
//   2) detectOffer()          — the rule that maps an ad/campaign -> an offer
// Nothing else in this file should need to change.
// ─────────────────────────────────────────────────────────────────────────────

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const GHL_KEY = Deno.env.get('GHL_API_KEY')
const GHL_LOC = Deno.env.get('GHL_LOCATION_ID')
const GHL_BASE = 'https://services.leadconnectorhq.com'
// Optional: some GHL accounts require a userId to attach a note. If set, we
// pass it; if not, we still try the note and just skip it on failure.
const GHL_NOTE_USER_ID = Deno.env.get('GHL_NOTE_USER_ID') || undefined

// The two offers, and every piece of naming attached to them, in one place.
//   tag          — written onto the GHL contact; the single source of truth
//   calendarCode — appended to the calendar event later (task 2): "... (T1)"
//   label        — human-readable, used in the note left on the lead
const OFFERS: Record<string, { tag: string; calendarCode: string; label: string }> = {
  trial:      { tag: 'offer-trial',     calendarCode: 'T1', label: 'Trial' },
  'map-stack': { tag: 'offer-map-stack', calendarCode: 'M1', label: 'Map Stacking' },
}
const OFFER_TAGS = new Set(Object.values(OFFERS).map(o => o.tag))

// ── detectOffer ──────────────────────────────────────────────────────────────
// Given a lead's Meta attribution, return 'trial' | 'map-stack' | null.
// Returns null (do nothing) when it can't tell — we never guess an offer.
//
// The signal (per Ben's Miro board): the landing-page / campaign naming
// convention. `*-vsl` funnels = trial, `*-dsl` funnels = map-stacking. Meta
// lead ads pass the campaign name through to `utmCampaign` on the contact, so
// as long as Ben keeps a token (vsl/dsl, or "trial"/"map stack") in his
// campaign names, it flows here automatically — no per-ad list to maintain.
//
// BEN: if your token lives ONLY in the Meta campaign *name* and does NOT reach
// utmCampaign, say so — we'd resolve campaignId -> campaign_name via the `ads`
// table (see migration 049) instead. Until then this reads the fields already
// on the contact and safely no-ops on anything it doesn't recognise.
function detectOffer(signals: {
  utmCampaign?: string | null
  utmContent?: string | null
  formName?: string | null
}): 'trial' | 'map-stack' | null {
  const hay = [signals.utmCampaign, signals.utmContent, signals.formName]
    .filter(Boolean).join(' ').toLowerCase()
  if (!hay) return null
  // Map-stacking first — it's the narrower, higher-value bucket.
  if (/\bdsl\b|map[\s_-]?stack/.test(hay)) return 'map-stack'
  if (/\bvsl\b|trial/.test(hay)) return 'trial'
  return null
}

// ── GHL helpers ──────────────────────────────────────────────────────────────
function ghlHeaders(extra: Record<string, string> = {}) {
  return {
    'Authorization': `Bearer ${GHL_KEY}`,
    'Version': '2021-07-28',
    'Accept': 'application/json',
    ...extra,
  }
}

function pickAttr(c: any) {
  const last = (c.lastAttributionSource && typeof c.lastAttributionSource === 'object') ? c.lastAttributionSource : {}
  const first = (c.attributionSource && typeof c.attributionSource === 'object') ? c.attributionSource : {}
  return { last, first }
}

// A contact carries attribution on lastAttributionSource (most recent touch);
// fall back to the first-touch object if the last-touch field is empty.
function attrSignals(c: any) {
  const { last, first } = pickAttr(c)
  return {
    utmCampaign: last.utmCampaign || first.utmCampaign || null,
    utmContent:  last.utmContent  || first.utmContent  || null,
    formName:    last.formName    || first.formName    || null,
  }
}

async function getContact(contactId: string): Promise<any | null> {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders() })
  if (!res.ok) throw new Error(`GET /contacts/${contactId} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  return json.contact || json || null
}

async function getRecentContacts(minutes: number): Promise<any[]> {
  const res = await fetch(`${GHL_BASE}/contacts/search`, {
    method: 'POST',
    headers: ghlHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      locationId: GHL_LOC,
      page: 1,
      pageLimit: 100,
      sort: [{ field: 'dateAdded', direction: 'desc' }],
    }),
  })
  if (!res.ok) throw new Error(`POST /contacts/search ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const cutoff = Date.now() - minutes * 60_000
  return (json.contacts || []).filter((c: any) => {
    const added = new Date(c.dateAdded || 0).getTime()
    return added >= cutoff
  })
}

async function addTag(contactId: string, tag: string): Promise<void> {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: 'POST',
    headers: ghlHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ tags: [tag] }),
  })
  if (!res.ok) throw new Error(`POST /contacts/${contactId}/tags ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

// Best-effort: a failed note must not undo a successful tag, so callers catch.
async function addNote(contactId: string, body: string): Promise<void> {
  const payload: Record<string, unknown> = { body }
  if (GHL_NOTE_USER_ID) payload.userId = GHL_NOTE_USER_ID
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: 'POST',
    headers: ghlHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`POST /contacts/${contactId}/notes ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

type Outcome = {
  contactId: string
  name?: string
  offer: string | null
  action: 'tagged' | 'skipped-already-tagged' | 'skipped-no-match' | 'would-tag' | 'error'
  detail?: string
}

async function processContact(c: any, dryRun: boolean): Promise<Outcome> {
  const contactId = c.id
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || undefined
  const existing: string[] = Array.isArray(c.tags) ? c.tags : []

  if (existing.some(t => OFFER_TAGS.has(t))) {
    return { contactId, name, offer: null, action: 'skipped-already-tagged' }
  }

  const signals = attrSignals(c)
  const offer = detectOffer(signals)
  if (!offer) return { contactId, name, offer: null, action: 'skipped-no-match' }

  const cfg = OFFERS[offer]
  const matched = [signals.utmCampaign, signals.utmContent, signals.formName].filter(Boolean).join(' | ')

  if (dryRun) {
    return { contactId, name, offer, action: 'would-tag', detail: `${cfg.tag} <- "${matched}"` }
  }

  try {
    await addTag(contactId, cfg.tag)
  } catch (e) {
    return { contactId, name, offer, action: 'error', detail: (e as Error).message }
  }
  // Note is best-effort; tag is what downstream relies on.
  try {
    await addNote(contactId, `Offer detected: ${cfg.label} (${cfg.calendarCode}). Matched attribution: "${matched}". Auto-tagged by tag-lead-offers.`)
  } catch { /* note failed, tag still stands */ }

  return { contactId, name, offer, action: 'tagged', detail: cfg.tag }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const reply = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  if (!GHL_KEY || !GHL_LOC) return reply({ error: 'GHL_API_KEY / GHL_LOCATION_ID not set' }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* empty body = batch defaults */ }
  const dryRun = body.dryRun === true
  const minutes = typeof body.minutes === 'number' ? body.minutes : 240

  try {
    let contacts: any[]
    if (body.contactId) {
      const c = await getContact(body.contactId)
      contacts = c ? [c] : []
    } else {
      contacts = await getRecentContacts(minutes)
    }

    const results: Outcome[] = []
    for (const c of contacts) results.push(await processContact(c, dryRun))

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.action] = (acc[r.action] || 0) + 1
      return acc
    }, {})

    return reply({ ok: true, dryRun, scanned: contacts.length, counts, results })
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message }, 500)
  }
})
