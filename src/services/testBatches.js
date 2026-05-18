import { supabase } from '../lib/supabase'

/*
  Test-batch CRUD. A test batch is a named bundle of generated_scripts —
  either a draft (launched_at IS NULL) or a launched test (linked to one
  or more Meta campaigns).
*/

function toSlug(name) {
  return String(name || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Create a new draft batch. */
export async function createTestBatch({ name, hypothesis = null, offer_slug = null, notes = null }) {
  if (!name?.trim()) throw new Error('Test batch name is required')
  const slug = toSlug(name)
  const { data, error } = await supabase
    .from('test_batches')
    .insert({ name: name.trim(), slug, hypothesis, offer_slug, notes })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function updateTestBatch(id, patch) {
  if (!id) throw new Error('id required')
  const allowed = ['name', 'hypothesis', 'notes', 'offer_slug', 'campaign_names', 'launched_at', 'closed_at']
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)))
  if (patch.name) clean.slug = toSlug(patch.name)
  const { data, error } = await supabase
    .from('test_batches')
    .update(clean)
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteTestBatch(id) {
  if (!id) throw new Error('id required')
  // Scripts retain their content; we just null out the link so they fall
  // back to "loose drafts" instead of being orphaned.
  const { error: e1 } = await supabase
    .from('generated_scripts')
    .update({ test_batch_id: null })
    .eq('test_batch_id', id)
  if (e1) throw new Error(`Unlinking scripts: ${e1.message}`)
  const { error } = await supabase.from('test_batches').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** List every batch with its script count. Newest first. */
export async function listTestBatches({ launched = null } = {}) {
  let q = supabase
    .from('test_batches')
    .select(`
      id, name, slug, hypothesis, notes, offer_slug,
      created_at, launched_at, closed_at, campaign_names, updated_at,
      generated_scripts(id, target_attributes, ad_id, status)
    `)
    .order('created_at', { ascending: false })

  if (launched === true) q = q.not('launched_at', 'is', null)
  else if (launched === false) q = q.is('launched_at', null)

  const { data, error } = await q
  if (error) throw new Error(error.message)

  // Compute density client-side from the embedded scripts. Simpler than a
  // SQL view and keeps the data shape consistent with what the UI needs.
  return (data || []).map(b => {
    const scripts = b.generated_scripts || []
    return {
      id: b.id,
      name: b.name,
      slug: b.slug,
      hypothesis: b.hypothesis,
      notes: b.notes,
      offer_slug: b.offer_slug,
      created_at: b.created_at,
      launched_at: b.launched_at,
      closed_at: b.closed_at,
      campaign_names: b.campaign_names || [],
      updated_at: b.updated_at,
      script_count: scripts.length,
      linked_count: scripts.filter(s => s.ad_id).length,
      density: computeDensity(scripts),
    }
  })
}

/** Get one batch + its scripts (full body included). */
export async function getTestBatch(id) {
  if (!id) throw new Error('id required')
  const [batchRes, scriptsRes] = await Promise.all([
    supabase.from('test_batches').select('*').eq('id', id).maybeSingle(),
    supabase.from('generated_scripts')
      .select('*')
      .eq('test_batch_id', id)
      .order('created_at', { ascending: false }),
  ])
  if (batchRes.error) throw new Error(batchRes.error.message)
  if (!batchRes.data) throw new Error('Test batch not found')
  if (scriptsRes.error) throw new Error(scriptsRes.error.message)
  const scripts = scriptsRes.data || []
  return {
    ...batchRes.data,
    scripts,
    density: computeDensity(scripts),
    script_count: scripts.length,
    linked_count: scripts.filter(s => s.ad_id).length,
  }
}

/** Attach existing scripts to a batch. Idempotent. */
export async function addScriptsToBatch(batchId, scriptIds) {
  if (!batchId) throw new Error('batchId required')
  if (!scriptIds?.length) return { updated: 0 }
  const { data, error } = await supabase
    .from('generated_scripts')
    .update({ test_batch_id: batchId })
    .in('id', scriptIds)
    .select('id')
  if (error) throw new Error(error.message)
  return { updated: data?.length || 0 }
}

/** Remove scripts from a batch (sets test_batch_id NULL). */
export async function removeScriptsFromBatch(scriptIds) {
  if (!scriptIds?.length) return { updated: 0 }
  const { data, error } = await supabase
    .from('generated_scripts')
    .update({ test_batch_id: null })
    .in('id', scriptIds)
    .select('id')
  if (error) throw new Error(error.message)
  return { updated: data?.length || 0 }
}

/** Mark a batch as launched. Optional campaign_names to capture where it shipped. */
export async function launchTestBatch(id, { campaign_names = [] } = {}) {
  return updateTestBatch(id, {
    launched_at: new Date().toISOString(),
    campaign_names,
  })
}

/** Mark a batch as closed (test complete). */
export async function closeTestBatch(id) {
  return updateTestBatch(id, { closed_at: new Date().toISOString() })
}

/**
 * Parse a free-form doc into N ad scripts via Claude. Client side: the
 * operator has already extracted text (we accept text only; the upload
 * modal handles file extraction via docExtract.js). Returns the parsed
 * scripts BEFORE they're saved so the operator can review + edit.
 */
export async function parseScriptsFromDoc({ text, offer_slug = null }) {
  if (!text?.trim()) throw new Error('text required')
  const { data, error } = await supabase.functions.invoke('creative-parse-doc', {
    body: { text, offer_slug },
  })
  // supabase-js wraps non-2xx in a FunctionsHttpError whose default .message
  // is "Edge Function returned a non-2xx status code" — useless. The real
  // error body is on `error.context` (a Response). Read it so the operator
  // sees what actually failed (e.g. "Document too long — Claude ran out…").
  if (error) {
    let detail = error.message || 'creative-parse-doc failed'
    try {
      const body = await error.context?.json?.()
      if (body?.error) detail = body.error
    } catch { /* fall back to generic */ }
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error)
  return data?.scripts || []
}

/**
 * Bulk-insert pre-parsed scripts into generated_scripts and attach them
 * to a batch. Used by UploadScriptsModal after the operator approves the
 * parsed output.
 */
export async function bulkSaveScriptsToBatch({ batchId, offer_slug, scripts }) {
  if (!batchId) throw new Error('batchId required')
  if (!scripts?.length) return { inserted: 0 }
  const rows = scripts.map(s => ({
    title: s.title || null,
    body: s.body || '',
    target_attributes: s.target_attributes || {},
    status: 'draft',
    offer_slug: offer_slug || null,
    notes: s.reasoning || null,
    test_batch_id: batchId,
    generated_by_model: 'parsed-from-doc',
  }))
  const { data, error } = await supabase
    .from('generated_scripts')
    .insert(rows)
    .select('id')
  if (error) throw new Error(error.message)
  return { inserted: data?.length || 0 }
}

/** Search existing scripts to attach to a batch. */
export async function searchScriptsForAttach({ query = '', offer_slug = null, excludeBatchId = null, limit = 100 } = {}) {
  let q = supabase
    .from('generated_scripts')
    .select('id, title, body, target_attributes, status, ad_id, test_batch_id, offer_slug, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (offer_slug) q = q.eq('offer_slug', offer_slug)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  let rows = data || []
  if (excludeBatchId) rows = rows.filter(r => r.test_batch_id !== excludeBatchId)
  if (query.trim()) {
    const Q = query.toLowerCase()
    rows = rows.filter(r =>
      (r.title || '').toLowerCase().includes(Q) ||
      (r.body  || '').toLowerCase().includes(Q)
    )
  }
  return rows
}

// ─── density helper ──────────────────────────────────────────────────
const DIMENSIONS = ['hook_type', 'message_frame', 'mechanism_reveal', 'pain_angle', 'proof_character', 'funnel_stage']

function computeDensity(scripts) {
  const out = {}
  for (const dim of DIMENSIONS) out[dim] = {}
  for (const s of scripts) {
    const a = s.target_attributes || {}
    for (const dim of DIMENSIONS) {
      const v = a[dim]
      if (!v) continue
      out[dim][v] = (out[dim][v] || 0) + 1
    }
  }
  return out
}
