import { supabase } from '../lib/supabase'

/*
  Creative Tagger client. Calls the `creative-tag-ad` Supabase Edge
  Function to extract test-variable attributes from an ad's transcript
  via Claude. Anthropic key stays server-side.

  Edge Function source: supabase/functions/creative-tag-ad/index.ts
*/

/** Tag a single ad. Returns the extracted attributes. */
export async function tagAd(ad_id) {
  if (!ad_id) throw new Error('tagAd: ad_id required')
  const { data, error } = await supabase.functions.invoke('creative-tag-ad', {
    body: { mode: 'one', ad_id },
  })
  if (error) throw new Error(error.message || 'creative-tag-ad failed')
  if (data?.error) throw new Error(data.error)
  const result = data?.results?.[0]
  if (!result) throw new Error('no result returned')
  if (!result.ok) throw new Error(result.error || 'tagging failed')
  return result.attributes
}

/** Tag many ads in a single call. Concurrency-bounded server-side. */
export async function tagBatch(ad_ids) {
  if (!Array.isArray(ad_ids) || !ad_ids.length) return { processed: 0, results: [] }
  const { data, error } = await supabase.functions.invoke('creative-tag-ad', {
    body: { mode: 'batch', ad_ids },
  })
  if (error) throw new Error(error.message || 'creative-tag-ad failed')
  if (data?.error) throw new Error(data.error)
  return data
}

/** Tag the next N ads that don't yet have an extracted_at row. */
export async function tagMissing(limit = 25) {
  const { data, error } = await supabase.functions.invoke('creative-tag-ad', {
    body: { mode: 'missing', limit },
  })
  if (error) throw new Error(error.message || 'creative-tag-ad failed')
  if (data?.error) throw new Error(data.error)
  return data
}

/** Read the controlled vocabulary used by the dropdowns. */
export async function getAttributeVocab() {
  const { data, error } = await supabase
    .from('creative_attribute_vocab')
    .select('attribute_name, attribute_value, label, description, sort_order')
    .eq('retired', false)
    .order('attribute_name')
    .order('sort_order')
  if (error) throw new Error(error.message)
  // Group by attribute_name → array of { value, label, description }
  const grouped = {}
  for (const row of data || []) {
    if (!grouped[row.attribute_name]) grouped[row.attribute_name] = []
    grouped[row.attribute_name].push({
      value: row.attribute_value,
      label: row.label,
      description: row.description,
    })
  }
  return grouped
}

/** Read the stored attributes for one ad. */
export async function getAdAttributes(ad_id) {
  if (!ad_id) throw new Error('getAdAttributes: ad_id required')
  const { data, error } = await supabase
    .from('creative_attributes')
    .select('*')
    .eq('ad_id', ad_id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/**
 * Operator override — manually set one or more attributes on an ad.
 * Patch object can include any of the 11 attribute columns + actor +
 * vertical + manual_winner_override + notes.
 */
export async function updateAdAttributes(ad_id, patch) {
  if (!ad_id) throw new Error('updateAdAttributes: ad_id required')
  const allowedKeys = [
    'offer_slug',
    'hook_type', 'message_frame', 'mechanism_reveal', 'proof_character',
    'pain_angle', 'funnel_stage', 'awareness_level', 'length_bucket', 'format',
    'actor', 'vertical', 'manual_winner_override', 'notes',
  ]
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([k]) => allowedKeys.includes(k))
  )
  // Upsert keyed on ad_id (creates row if first time operator touches it)
  const { data, error } = await supabase
    .from('creative_attributes')
    .upsert({ ad_id, ...clean }, { onConflict: 'ad_id' })
    .select()
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data
}

/** List all offers (for dropdowns). */
export async function listOffers({ includeRetired = false } = {}) {
  let q = supabase.from('offers').select('*').order('vertical').order('name')
  if (!includeRetired) q = q.eq('retired', false)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data || []
}

/** Read the data-health coverage view. */
export async function getAttributeCoverage() {
  const { data, error } = await supabase.from('lib_attribute_coverage').select('*')
  if (error) throw new Error(error.message)
  return data || []
}
