import { supabase } from '../lib/supabase'

/*
  Script Generator client. Calls the `creative-generate-script` Supabase
  Edge Function to produce N ad-script concepts for any offer.

  Edge Function source: supabase/functions/creative-generate-script/index.ts
*/

/**
 * Generate N script concepts.
 *
 * Two modes (Ben 2026-05-31):
 *
 *   TEMPLATE — pass script_type + angle_slug. Edge Function uses the
 *   script_angles / proof_characters / hook_shapes / body_skeletons
 *   tables (migrations 105/106) to produce Hook-only, Body-only, or
 *   Joined (Hook+Body) scripts layered on top of the existing locked
 *   principles. Optional target_shapes filters hook shapes (A-H).
 *
 *   LEGACY — pass offer_slug + optional target_attributes. Falls
 *   through to the original 8-attribute generator.
 *
 * @param {object} opts
 * @param {string} [opts.script_type]                 — 'hook' | 'body' | 'joined'
 * @param {string} [opts.angle_slug]                  — FK to script_angles.slug
 * @param {string[]} [opts.target_shapes]             — A-H subset (template mode)
 * @param {string} [opts.target_length]               — 'under_60s' | '60_75s' | '75s_plus'
 * @param {string} [opts.offer_slug]                  — FK to offers.slug (legacy mode)
 * @param {number} [opts.n_concepts=3]                — 1-30
 * @param {object} [opts.target_attributes={}]        — legacy mode only
 * @param {boolean} [opts.save_as_drafts=false]       — persist to generated_scripts
 * @returns {Promise<{ ok, mode, scripts, ... }>}
 */
export async function generateScripts({
  script_type,
  angle_slug,
  mechanism_slug,     // optional (migration 108)
  target_shapes,
  target_length,
  offer_slug,
  n_concepts = 3,
  target_attributes = {},
  save_as_drafts = false,
  extra_instructions,    // optional free-text appended to the Claude prompt
} = {}) {
  if (!offer_slug && !(script_type && angle_slug)) {
    throw new Error('generateScripts: pass either offer_slug, or script_type + angle_slug')
  }
  const body = { n_concepts, save_as_drafts }
  if (script_type && angle_slug) {
    body.script_type = script_type
    body.angle_slug = angle_slug
    if (mechanism_slug) body.mechanism_slug = mechanism_slug
    if (target_shapes?.length) body.target_shapes = target_shapes
    if (target_length) body.target_length = target_length
  } else {
    body.offer_slug = offer_slug
    body.target_attributes = target_attributes
  }
  if (extra_instructions && extra_instructions.trim()) {
    body.extra_instructions = extra_instructions.trim()
  }
  const { data, error } = await supabase.functions.invoke('creative-generate-script', { body })
  if (error) throw new Error(error.message || 'creative-generate-script failed')
  if (data?.error) throw new Error(data.error)
  return data
}

/* ─────────────────────── Mechanism CRUD ─────────────────────── */
// Mechanisms = the WHAT-OPT-DELIVERS layer. Migration 108. They sit
// between angles (the prospect's door) and offers (the package).

export async function listMechanisms({ offer_slug, angle_slug, active_only = true } = {}) {
  let q = supabase
    .from('script_mechanisms')
    .select('slug,name,summary,mechanism_short,mechanism_long,beat_5a,beat_5b,beat_5c,offer_slugs,angle_slugs,active,notes')
    .order('name')
  if (active_only) q = q.eq('active', true)
  // Filter by offer/angle compat using overlaps + the empty-array "applies to all" convention
  // (filtering is applied client-side because PostgREST's overlaps op doesn't combine with
  // an empty-array fallback cleanly).
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data || []
  return rows.filter(m => {
    if (offer_slug && m.offer_slugs?.length && !m.offer_slugs.includes(offer_slug)) return false
    if (angle_slug && m.angle_slugs?.length && !m.angle_slugs.includes(angle_slug)) return false
    return true
  })
}

export async function upsertMechanism(mechanism) {
  if (!mechanism?.slug || !mechanism?.name || !mechanism?.mechanism_short || !mechanism?.mechanism_long) {
    throw new Error('upsertMechanism: slug, name, mechanism_short, mechanism_long are required')
  }
  const payload = {
    slug: mechanism.slug.trim(),
    name: mechanism.name.trim(),
    summary: (mechanism.summary || '').trim() || null,
    mechanism_short: mechanism.mechanism_short.trim(),
    mechanism_long: mechanism.mechanism_long.trim(),
    beat_5a: (mechanism.beat_5a || '').trim() || null,
    beat_5b: (mechanism.beat_5b || '').trim() || null,
    beat_5c: (mechanism.beat_5c || '').trim() || null,
    offer_slugs: Array.isArray(mechanism.offer_slugs) ? mechanism.offer_slugs : [],
    angle_slugs: Array.isArray(mechanism.angle_slugs) ? mechanism.angle_slugs : [],
    active: mechanism.active !== false,
    notes: (mechanism.notes || '').trim() || null,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('script_mechanisms')
    .upsert(payload, { onConflict: 'slug' })
    .select()
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/** List all active script angles (template mode). */
export async function listAngles({ offer_slug } = {}) {
  let q = supabase
    .from('script_angles')
    .select('slug,name,offer_slugs,qualifier,primary_promise,mechanism_short,angle_type,prospect_voice,hook_build_sketch,active')
    .eq('active', true)
    .order('angle_type', { nullsFirst: false })
    .order('name')
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = data || []
  if (offer_slug) {
    return rows.filter(a => !a.offer_slugs?.length || a.offer_slugs.includes(offer_slug))
  }
  return rows
}

/**
 * Generate N problems + M desires for an offer. Auto-saves to
 * script_angles tagged with the offer (Ben 2026-05-31 — Messaging mode
 * on /generate page). Returns the saved angle rows plus the raw
 * Claude output for inline display.
 *
 * @param {object} opts
 * @param {string} opts.offer_slug
 * @param {number} [opts.n_problems=5]
 * @param {number} [opts.n_desires=5]
 * @param {string} [opts.niche_hint]   — optional context (niche, situation, vertical specifics)
 */
export async function generateAngles({ offer_slug, n_problems = 5, n_desires = 5, niche_hint, extra_instructions } = {}) {
  if (!offer_slug) throw new Error('generateAngles: offer_slug required')
  const { data, error } = await supabase.functions.invoke('creative-generate-script', {
    body: {
      generation_target: 'angles',
      offer_slug,
      n_problems,
      n_desires,
      niche_hint: niche_hint || undefined,
      extra_instructions: (extra_instructions && extra_instructions.trim()) || undefined,
    },
  })
  if (error) throw new Error(error.message || 'angle generation failed')
  if (data?.error) throw new Error(data.error)
  return data
}

/** List the catalog of opening-move shapes (A-H). */
export async function listHookShapes() {
  const { data, error } = await supabase
    .from('script_hook_shapes')
    .select('code,name,description,message_frame,display_order,active')
    .eq('active', true)
    .order('display_order')
  if (error) throw new Error(error.message)
  return data || []
}

/** List body skeleton options (length-bucket variants). */
export async function listBodySkeletons() {
  const { data, error } = await supabase
    .from('script_body_skeletons')
    .select('code,name,description,length_bucket,display_order,active')
    .eq('active', true)
    .order('display_order')
  if (error) throw new Error(error.message)
  return data || []
}

/** List proof characters defined under a specific angle. */
export async function listProofCharacters(angle_slug) {
  if (!angle_slug) return []
  const { data, error } = await supabase
    .from('script_proof_characters')
    .select('name,result_short,result_long,industry_context,metric_kind,display_order')
    .eq('angle_slug', angle_slug)
    .eq('active', true)
    .order('display_order')
  if (error) throw new Error(error.message)
  return data || []
}

/** List previously generated script drafts. */
export async function listGeneratedScripts({ offer_slug, status, limit = 50 } = {}) {
  let q = supabase
    .from('generated_scripts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (offer_slug) q = q.eq('offer_slug', offer_slug)
  if (status) q = q.eq('status', status)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

/** Mark a generated script's status — draft → approved → filming → filmed → shipped. */
export async function updateGeneratedScript(id, patch) {
  if (!id) throw new Error('updateGeneratedScript: id required')
  const allowedKeys = ['status', 'title', 'body', 'target_attributes', 'ad_id', 'notes']
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowedKeys.includes(k))
  )
  const { data, error } = await supabase
    .from('generated_scripts')
    .update(clean)
    .eq('id', id)
    .select()
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/**
 * Link a generated script to a real Meta ad once filmed + uploaded.
 * Carries the script's target_attributes into creative_attributes so
 * the LLM extraction is bypassed for known scripts.
 *
 * Merge semantics: only writes columns the script has values for.
 * Existing manual overrides (actor, format, manual_winner_override,
 * existing operator notes) are preserved. The script's notes are
 * appended to any existing notes, not replaced.
 */
export async function linkScriptToAd(script_id, ad_id) {
  if (!script_id || !ad_id) throw new Error('linkScriptToAd: script_id and ad_id required')

  // 1. Load the script
  const { data: script, error: e1 } = await supabase
    .from('generated_scripts')
    .select('*')
    .eq('id', script_id)
    .maybeSingle()
  if (e1) throw new Error(e1.message)
  if (!script) throw new Error(`script ${script_id} not found`)

  // 2. Load any existing creative_attributes for this ad (to merge, not clobber)
  const { data: existing, error: e2 } = await supabase
    .from('creative_attributes')
    .select('*')
    .eq('ad_id', ad_id)
    .maybeSingle()
  if (e2) throw new Error(e2.message)

  // 3. Build merge payload — only include keys where the script has values
  const t = script.target_attributes || {}
  const scriptFrame = (script.frame || '').toLowerCase()

  const linkNote = `Linked to generated_scripts ${script_id} on ${new Date().toISOString().slice(0, 10)}`
  const mergedNotes = existing?.notes
    ? (existing.notes.includes(linkNote) ? existing.notes : `${existing.notes}\n\n${linkNote}`)
    : linkNote

  const payload = { ad_id }
  if (script.offer_slug) payload.offer_slug = script.offer_slug
  if (t.hook_type) payload.hook_type = t.hook_type
  if (scriptFrame) payload.message_frame = scriptFrame
  if (t.mechanism_reveal) payload.mechanism_reveal = t.mechanism_reveal
  if (t.proof_character) payload.proof_character = t.proof_character
  if (t.pain_angle) payload.pain_angle = t.pain_angle
  if (t.funnel_stage) payload.funnel_stage = t.funnel_stage
  if (t.awareness_level) payload.awareness_level = t.awareness_level
  if (t.length_bucket) payload.length_bucket = t.length_bucket
  payload.extracted_at = new Date().toISOString()
  payload.extracted_by_model = 'generated-script-link'
  payload.notes = mergedNotes

  // 4. Upsert creative_attributes (merge semantics — other columns preserved)
  const { error: e3 } = await supabase
    .from('creative_attributes')
    .upsert(payload, { onConflict: 'ad_id' })
  if (e3) throw new Error(e3.message)

  // 5. Mark script as shipped
  const { error: e4 } = await supabase
    .from('generated_scripts')
    .update({ ad_id, status: 'shipped' })
    .eq('id', script_id)
  if (e4) throw new Error(e4.message)

  return { ok: true, script_id, ad_id, had_existing: !!existing }
}
