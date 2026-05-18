import { supabase } from '../lib/supabase'

/*
  Script Generator client. Calls the `creative-generate-script` Supabase
  Edge Function to produce N ad-script concepts for any offer.

  Edge Function source: supabase/functions/creative-generate-script/index.ts
*/

/**
 * Generate N script concepts for an offer.
 *
 * @param {object} opts
 * @param {string} opts.offer_slug                    — FK to offers.slug
 * @param {number} [opts.n_concepts=3]                — 1-10
 * @param {object} [opts.target_attributes={}]        — bias hints (hook_type, pain_angle, etc)
 * @param {boolean} [opts.save_as_drafts=false]       — persist to generated_scripts
 * @returns {Promise<{ ok, offer, scripts, saved_variant_ids, model }>}
 */
export async function generateScripts({
  offer_slug,
  n_concepts = 3,
  target_attributes = {},
  save_as_drafts = false,
} = {}) {
  if (!offer_slug) throw new Error('generateScripts: offer_slug required')
  const { data, error } = await supabase.functions.invoke('creative-generate-script', {
    body: { offer_slug, n_concepts, target_attributes, save_as_drafts },
  })
  if (error) throw new Error(error.message || 'creative-generate-script failed')
  if (data?.error) throw new Error(data.error)
  return data
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
