import { supabase } from '../lib/supabase'
import { BASE_URL, GHL_LOCATION_ID, ghlFetch } from './ghlClient'

/**
 * Fetch all GHL workflows and cache them in ghl_workflows table.
 */
export async function fetchWorkflows() {
  const res = await ghlFetch(`${BASE_URL}/workflows/?locationId=${GHL_LOCATION_ID}`)
  if (!res.ok) throw new Error(`Workflows fetch failed: ${res.status}`)
  const data = await res.json()
  const workflows = (data.workflows || []).map(w => ({
    id: w.id,
    name: w.name,
    status: w.status,
    synced_at: new Date().toISOString(),
  }))
  if (workflows.length > 0) {
    const { error } = await supabase.from('ghl_workflows').upsert(workflows, { onConflict: 'id' })
    if (error) console.error('Workflow upsert failed:', error)
  }
  return workflows
}

/**
 * Incrementally sync email messages from GHL conversations.
 * Pulls email-type conversations, fetches messages, and caches them.
 *
 * @param {number} daysBack - How many days to look back (default 30)
 * @param {function} onProgress - Progress callback (current, total)
 * @returns {{ synced: number, skipped: number, total: number }}
 */
export async function syncEmailMessages(daysBack = 30, onProgress = () => {}) {
  // Get IDs we already have to skip
  const { data: cached } = await supabase.from('email_message_cache').select('id')
  const cachedIds = new Set((cached || []).map(r => r.id))

  let synced = 0, skipped = 0

  // Fetch ALL email conversations — GHL /conversations/search returns up to
  // ~2000 results for lastMessageType=TYPE_EMAIL. No cursor pagination available,
  // so we fetch a single large batch. The limit of 100 per page is the API max.
  let allConvos = []
  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      locationId: GHL_LOCATION_ID,
      lastMessageType: 'TYPE_EMAIL',
      limit: '100',
    })
    // Use startAfterDate for pagination if we have previous results
    if (allConvos.length > 0) {
      const lastDate = allConvos[allConvos.length - 1]?.lastMessageDate
      if (lastDate) params.set('startAfterDate', String(lastDate))
    }
    const res = await ghlFetch(`${BASE_URL}/conversations/search?${params}`)
    if (!res.ok) break
    const data = await res.json()
    const convos = data.conversations || []
    if (convos.length === 0) break
    allConvos = allConvos.concat(convos)
    if (convos.length < 100) break // last page
  }

  onProgress(0, allConvos.length)

  // For each conversation, fetch messages and find email IDs
  // Rate limit: pause briefly every 50 requests to avoid GHL 429s
  const emailDetailJobs = []
  let convIdx = 0
  for (const convo of allConvos) {
    convIdx++
    onProgress(convIdx, allConvos.length)
    if (convIdx % 50 === 0) await new Promise(r => setTimeout(r, 1000))

    try {
      const msgRes = await ghlFetch(`${BASE_URL}/conversations/${convo.id}/messages`)
      if (msgRes.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue }
      if (!msgRes.ok) continue
      const msgData = await msgRes.json()
      const messages = msgData.messages?.messages || []

      for (const msg of messages) {
        if (msg.messageType !== 'TYPE_EMAIL') continue
        const innerIds = msg.meta?.email?.messageIds || []
        for (const innerId of innerIds) {
          if (cachedIds.has(innerId)) { skipped++; continue }
          emailDetailJobs.push({ innerId, convoId: convo.id })
        }
      }
    } catch (e) {
      // skip and continue
    }
  }

  // Fetch full email details in batches of 5 with rate limit pauses
  const rowsToUpsert = []
  for (let i = 0; i < emailDetailJobs.length; i += 5) {
    if (i > 0 && i % 50 === 0) await new Promise(r => setTimeout(r, 1000))
    const batch = emailDetailJobs.slice(i, i + 5)
    const results = await Promise.all(batch.map(async ({ innerId, convoId }) => {
      try {
        const r = await ghlFetch(`${BASE_URL}/conversations/messages/email/${innerId}`)
        if (!r.ok) return null
        const d = await r.json()
        const em = d.emailMessage
        if (!em) return null
        return {
          id: em.id,
          conversation_id: em.conversationId || convoId,
          contact_id: em.contactId || null,
          subject: em.subject || '(no subject)',
          status: em.status || null,
          source: em.source || null,
          direction: em.direction || null,
          date_added: em.dateAdded || null,
          date_updated: em.dateUpdated || null,
          provider: em.provider || null,
          synced_at: new Date().toISOString(),
        }
      } catch { return null }
    }))
    for (const row of results) if (row) rowsToUpsert.push(row)
  }

  // Upsert in batches of 100
  for (let i = 0; i < rowsToUpsert.length; i += 100) {
    const chunk = rowsToUpsert.slice(i, i + 100)
    const { error } = await supabase.from('email_message_cache').upsert(chunk, { onConflict: 'id' })
    if (error) console.error('Email cache upsert failed:', error)
    else synced += chunk.length
  }

  return { synced, skipped, total: allConvos.length }
}

/**
 * Re-sync the status of recently cached emails (to capture opens/clicks
 * that happened after the initial sync).
 */
export async function refreshRecentEmailStatuses(daysBack = 7) {
  const since = new Date()
  since.setDate(since.getDate() - daysBack)

  const { data: recent } = await supabase
    .from('email_message_cache')
    .select('id')
    .gte('date_added', since.toISOString())
    .in('status', ['delivered', 'sent'])  // only re-check ones not yet opened/clicked

  let updated = 0
  const ids = (recent || []).map(r => r.id)

  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10)
    const results = await Promise.all(batch.map(async (id) => {
      try {
        const r = await ghlFetch(`${BASE_URL}/conversations/messages/email/${id}`)
        if (!r.ok) return null
        const d = await r.json()
        return d.emailMessage ? { id, status: d.emailMessage.status } : null
      } catch { return null }
    }))
    for (const row of results) {
      if (row) {
        await supabase.from('email_message_cache').update({ status: row.status, synced_at: new Date().toISOString() }).eq('id', row.id)
        updated++
      }
    }
  }

  return { updated, checked: ids.length }
}

/**
 * Normalize an email subject by stripping personalized variables so the same
 * automation email shows as one row regardless of which contact it went to.
 *
 * Examples:
 *   "Hey Tom, see you in 15!"               → "Hey {NAME}, see you in 15!"
 *   "Tom + Eric Introduction"               → "{NAME} + Eric Introduction"
 *   "FWD: can you please email Tom Hresko"  → "FWD: can you please email {NAME}"
 *   "Tom, missed you but I held the space"  → "{NAME}, missed you but I held the space"
 *   "Kyle here's how we get you calls"      → "{NAME} here's how we get you calls"
 *   "Appointment Confirmation on Thursday, April 9, 2026 3:30 PM (EDT)" → "Appointment Confirmation on {DATE}"
 *   "Re: your application Tom"              → "Re: your application {NAME}"
 */
export function normalizeSubject(subject) {
  if (!subject) return '(no subject)'
  let s = subject.trim()

  // Strip date+time patterns (Appointment Confirmation etc.)
  s = s.replace(/\bon\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Z][a-z]+\s+\d{1,2},?\s+\d{4}.*$/i, 'on {DATE}')
  s = s.replace(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,\s+[A-Z][a-z]+\s+\d{1,2}.*$/i, '{DATE}')
  s = s.replace(/\b\d{1,2}:\d{2}\s*(AM|PM)\s*\([A-Z]{2,4}\)/gi, '')

  // Pattern: "Name + Eric Introduction" / "Name + Anything Introduction"
  s = s.replace(/^[A-Z][a-zA-Z]+\s+\+\s+(\w+)\s+Introduction$/i, '{NAME} + $1 Introduction')

  // Pattern: "FWD: can you please email FirstName LastName"
  s = s.replace(/^(FWD:\s+can you please email)\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]*)*$/i, '$1 {NAME}')

  // Pattern: "Name, missed you but I held the space" / "Name, This remodeler..."
  // Any "Capitalized, " at start where the name is a first name (not a real word)
  s = s.replace(/^[A-Z][a-zA-Z]+,\s+(.+)$/i, (match, rest) => {
    const name = match.split(',')[0].trim()
    // Skip if it's a common word, not a name
    if (/^(The|This|That|And|But|For|With|What|Why|How|When|Where)$/i.test(name)) return match
    return `{NAME}, ${rest}`
  })

  // Pattern: "Name here's ..." (no comma, name at start followed by lowercase)
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(here'?s\s+.*)$/i, '{NAME} $1')

  // Pattern: "Name how fast..." / "Name how can..."
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(how\s+(can|fast|do|will|much).*)$/i, '{NAME} $1')

  // Pattern: "Name this is..." / "Name that..." / "Name what..."
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(this\s+is\s+.*)$/i, '{NAME} $1')
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(that\s+.*)$/i, '{NAME} $1')
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(what\s+.*)$/i, '{NAME} $1')
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(we\s+.*)$/i, '{NAME} $1')
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(I\s+.*)$/i, '{NAME} $1')

  // Pattern: "Hey Name," / "Hi Name," / "Hey Name " (no comma)
  s = s.replace(/^(Hey|Hi|Hello)\s+[A-Z][a-zA-Z]+([,\s])/i, '$1 {NAME}$2')

  // Collapse repeated whitespace
  s = s.replace(/\s+/g, ' ').trim()

  return s
}

/**
 * Aggregate email stats per subject for the date range.
 * Only includes outbound emails. Also counts replies (inbound emails in
 * the same conversation that arrived AFTER the outbound was sent).
 */
// Module-level cache for email flow page data. Prewarmed on Layout mount so
// the Email Flows page renders instantly instead of waiting on Supabase.
const statsCache = new Map()  // `${fromDate}:${toDate}` → { data, ts }
const flowGroupsCache = { data: null, ts: 0 }
const subjectMetaCache = { data: null, ts: 0 }
const STATS_TTL_MS = 5 * 60 * 1000  // stats can move — 5 min
const GROUPS_TTL_MS = 10 * 60 * 1000  // flow groups rarely change — 10 min
const META_TTL_MS = 10 * 60 * 1000

export function clearEmailFlowCaches() {
  statsCache.clear()
  flowGroupsCache.data = null
  flowGroupsCache.ts = 0
  subjectMetaCache.data = null
  subjectMetaCache.ts = 0
}

export async function loadEmailStats(fromDate, toDate) {
  const key = `${fromDate}:${toDate}`
  const cached = statsCache.get(key)
  if (cached && (Date.now() - cached.ts) < STATS_TTL_MS) return cached.data
  const data = await _loadEmailStats(fromDate, toDate)
  statsCache.set(key, { data, ts: Date.now() })
  return data
}

async function _loadEmailStats(fromDate, toDate) {
  // Pull outbound emails in the date range
  const { data: outbound } = await supabase
    .from('email_message_cache')
    .select('id, subject, status, source, direction, date_added, contact_id, conversation_id')
    .gte('date_added', fromDate)
    .lte('date_added', toDate + 'T23:59:59')
    .eq('direction', 'outbound')
    .order('date_added', { ascending: false })

  // Pull ALL inbound emails (we'll match by conversation_id + date)
  const { data: inbound } = await supabase
    .from('email_message_cache')
    .select('conversation_id, date_added')
    .eq('direction', 'inbound')

  // Index inbound by conversation_id
  const inboundByConvo = {}
  for (const ib of (inbound || [])) {
    if (!ib.conversation_id) continue
    if (!inboundByConvo[ib.conversation_id]) inboundByConvo[ib.conversation_id] = []
    inboundByConvo[ib.conversation_id].push(ib.date_added)
  }

  const bySubject = {}
  for (const e of (outbound || [])) {
    const key = normalizeSubject(e.subject)
    if (!bySubject[key]) {
      bySubject[key] = {
        subject: key,
        source: e.source,
        rawSubjects: new Set(),
        repliedConvos: new Set(),
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        failed: 0,
        lastSent: e.date_added,
        contactIds: new Set(),
      }
    }
    const s = bySubject[key]
    s.rawSubjects.add(e.subject || '(no subject)')
    s.sent++

    // Check if this conversation got a reply AFTER this outbound
    if (e.conversation_id && inboundByConvo[e.conversation_id]) {
      const replied = inboundByConvo[e.conversation_id].some(dt => dt > e.date_added)
      if (replied) s.repliedConvos.add(e.conversation_id)
    }
    if (e.status === 'delivered') s.delivered++
    if (e.status === 'opened') { s.delivered++; s.opened++ }
    if (e.status === 'clicked') { s.delivered++; s.opened++; s.clicked++ }
    if (e.status === 'failed') s.failed++
    if (e.contact_id) s.contactIds.add(e.contact_id)
    if (e.date_added > s.lastSent) s.lastSent = e.date_added
  }

  return Object.values(bySubject).map(s => ({
    subject: s.subject,
    source: s.source,
    variants: s.rawSubjects.size,
    replied: s.repliedConvos.size,
    sent: s.sent,
    delivered: s.delivered,
    opened: s.opened,
    clicked: s.clicked,
    failed: s.failed,
    deliveryRate: s.sent > 0 ? parseFloat(((s.delivered / s.sent) * 100).toFixed(1)) : 0,
    openRate: s.delivered > 0 ? parseFloat(((s.opened / s.delivered) * 100).toFixed(1)) : 0,
    clickRate: s.delivered > 0 ? parseFloat(((s.clicked / s.delivered) * 100).toFixed(1)) : 0,
    replyRate: s.delivered > 0 ? parseFloat(((s.repliedConvos.size / s.delivered) * 100).toFixed(1)) : 0,
    uniqueContacts: s.contactIds.size,
    lastSent: s.lastSent,
  })).sort((a, b) => b.sent - a.sent)
}

/**
 * Load cached workflow list from DB (does not hit GHL API).
 */
export async function loadCachedWorkflows() {
  const { data } = await supabase.from('ghl_workflows').select('*').order('name')
  return data || []
}

/**
 * Load all subject metadata (workflow assignments, monitor flags).
 * Returns a map keyed by normalized subject.
 */
export async function loadSubjectMeta() {
  if (subjectMetaCache.data && (Date.now() - subjectMetaCache.ts) < META_TTL_MS) {
    return subjectMetaCache.data
  }
  const { data, error } = await supabase.from('email_subject_meta').select('*')
  if (error) return subjectMetaCache.data || {}
  const map = {}
  for (const row of (data || [])) map[row.subject] = row
  subjectMetaCache.data = map
  subjectMetaCache.ts = Date.now()
  return map
}

/**
 * Bulk-assign multiple subjects to a single workflow.
 */
export async function bulkAssignWorkflow(subjects, workflowId, workflowName) {
  if (!subjects?.length) return false
  const now = new Date().toISOString()
  const rows = subjects.map(subject => ({
    subject,
    workflow_id: workflowId || null,
    workflow_name: workflowName || null,
    updated_at: now,
  }))
  const { error } = await supabase.from('email_subject_meta').upsert(rows, { onConflict: 'subject' })
  if (error) console.error('Bulk assign failed:', error)
  return !error
}

/**
 * Update metadata for a subject (workflow assignment, monitor flag).
 */
export async function updateSubjectMeta(subject, updates) {
  const payload = {
    subject,
    ...updates,
    updated_at: new Date().toISOString(),
  }
  if (updates.monitored === true) payload.monitored_at = new Date().toISOString()
  const { error } = await supabase.from('email_subject_meta').upsert(payload, { onConflict: 'subject' })
  if (error) console.error('Subject meta upsert failed:', error)
  return !error
}

// ── Flow Group CRUD ──

export async function loadFlowGroups() {
  if (flowGroupsCache.data && (Date.now() - flowGroupsCache.ts) < GROUPS_TTL_MS) {
    return flowGroupsCache.data
  }
  const { data } = await supabase.from('email_flow_groups').select('*').order('sort_order').order('name')
  const result = data || []
  flowGroupsCache.data = result
  flowGroupsCache.ts = Date.now()
  return result
}

export async function createFlowGroup(name, description = '', color = '#f0e050') {
  const { data, error } = await supabase.from('email_flow_groups').insert({ name, description, color }).select().single()
  if (error) { console.error('Create flow group failed:', error); return null }
  flowGroupsCache.data = null
  return data
}

export async function updateFlowGroup(id, updates) {
  const { error } = await supabase.from('email_flow_groups').update(updates).eq('id', id)
  if (error) console.error('Update flow group failed:', error)
  else flowGroupsCache.data = null
  return !error
}

export async function deleteFlowGroup(id) {
  // Clear flow_group_id on all assigned subjects first
  await supabase.from('email_subject_meta').update({ flow_group_id: null, updated_at: new Date().toISOString() }).eq('flow_group_id', id)
  const { error } = await supabase.from('email_flow_groups').delete().eq('id', id)
  if (error) console.error('Delete flow group failed:', error)
  else {
    flowGroupsCache.data = null
    subjectMetaCache.data = null
  }
  return !error
}

export async function assignSubjectsToFlow(subjects, flowGroupId) {
  if (!subjects?.length) return false
  const now = new Date().toISOString()
  const rows = subjects.map(subject => ({ subject, flow_group_id: flowGroupId, updated_at: now }))
  const { error } = await supabase.from('email_subject_meta').upsert(rows, { onConflict: 'subject' })
  if (error) console.error('Assign to flow failed:', error)
  else subjectMetaCache.data = null
  return !error
}

/**
 * Load individual email records for a given normalized subject.
 * Returns per-contact entries with status, date, contact_id.
 */
/**
 * Load recipients for a given normalized subject.
 *
 * Fast path: resolves names ONLY from the Supabase `ghl_contacts_cache` table —
 * no GHL API calls on the hot path. Opening the dropdown used to block for
 * 20+ seconds on large flows because name resolution went out to GHL 5 at a
 * time with a 1s sleep every 25 requests. Now the UI renders in <1s.
 *
 * @param {Function} [onNamesResolved] — optional callback. Fires after the
 *   background GHL fetch completes with the updated recipient list (same
 *   shape) so the UI can re-render with fresh names. Pass null/undefined
 *   if you don't need the refresh.
 */
export async function loadEmailRecipients(normalizedSubject, fromDate, toDate, onNamesResolved) {
  const { data } = await supabase
    .from('email_message_cache')
    .select('id, subject, status, contact_id, date_added, conversation_id')
    .eq('direction', 'outbound')
    .gte('date_added', fromDate)
    .lte('date_added', toDate + 'T23:59:59')
    .order('date_added', { ascending: false })

  const matching = (data || []).filter(e => normalizeSubject(e.subject) === normalizedSubject)

  // Replies lookup — bounded by conversation_ids we care about, same window, row cap.
  const interestingConvos = [...new Set(matching.map(e => e.conversation_id).filter(Boolean))]
  const inboundByConvo = {}
  if (interestingConvos.length > 0) {
    const { data: inbound } = await supabase
      .from('email_message_cache')
      .select('conversation_id, date_added')
      .eq('direction', 'inbound')
      .in('conversation_id', interestingConvos)
      .gte('date_added', fromDate)
      .lte('date_added', toDate + 'T23:59:59')
      .limit(2000)

    for (const ib of (inbound || [])) {
      if (!ib.conversation_id) continue
      if (!inboundByConvo[ib.conversation_id]) inboundByConvo[ib.conversation_id] = []
      inboundByConvo[ib.conversation_id].push(ib.date_added)
    }
  }

  // Resolve contact IDs to names — cache only on the hot path.
  const uniqueContactIds = [...new Set(matching.map(e => e.contact_id).filter(Boolean))]
  const contactNames = {}
  if (uniqueContactIds.length > 0) {
    const { data: cached } = await supabase
      .from('ghl_contacts_cache')
      .select('id, name')
      .in('id', uniqueContactIds)
    for (const c of (cached || [])) {
      if (c.name) contactNames[c.id] = c.name
    }
  }

  const toRecipients = (nameMap) => matching.map(e => ({
    id: e.id,
    rawSubject: e.subject,
    status: e.status,
    contactId: e.contact_id,
    contactName: nameMap[e.contact_id] || (e.contact_id ? `Contact ${e.contact_id.slice(0, 8)}` : 'Unknown'),
    date: e.date_added,
    replied: e.conversation_id && inboundByConvo[e.conversation_id]?.some(dt => dt > e.date_added),
  }))

  // Backfill missing names in the background. If the caller passed an
  // onNamesResolved callback, invoke it once fresh names land so the UI
  // can re-render without the user having to close and reopen the dropdown.
  const uncachedIds = uniqueContactIds.filter(id => !contactNames[id])
  if (uncachedIds.length > 0) {
    resolveRecipientNamesInBackground(uncachedIds, async (resolved) => {
      if (!onNamesResolved) return
      const merged = { ...contactNames, ...resolved }
      onNamesResolved(toRecipients(merged))
    })
  }

  return toRecipients(contactNames)
}

/**
 * Fire-and-forget GHL contact name resolution.
 *
 * Caps at 100 contacts per call. Used by loadEmailRecipients on dropdown open
 * AND by prewarmRecipientNameCache on Email Flows page mount — the latter
 * pre-populates the cache so the very first dropdown open already has names.
 *
 * @param {string[]} contactIds
 * @param {Function} [onResolved] — callback receiving { [id]: name } map
 *   of newly-resolved names so callers can refresh their UI.
 */
function resolveRecipientNamesInBackground(contactIds, onResolved) {
  const capped = contactIds.slice(0, 100)
  ;(async () => {
    const resolved = {}
    const newlyCached = []
    for (let i = 0; i < capped.length; i += 10) {
      const batch = capped.slice(i, i + 10)
      const results = await Promise.all(batch.map(async cid => {
        try {
          const r = await ghlFetch(`${BASE_URL}/contacts/${cid}`)
          if (!r.ok) return null
          const d = await r.json()
          const c = d.contact || d
          const name = `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email || null
          return name ? { id: cid, name, email: c.email || null } : null
        } catch { return null }
      }))
      for (const r of results) {
        if (r) {
          newlyCached.push(r)
          resolved[r.id] = r.name
        }
      }
    }
    if (newlyCached.length > 0) {
      await supabase.from('ghl_contacts_cache')
        .upsert(newlyCached.map(c => ({ ...c, synced_at: new Date().toISOString() })), { onConflict: 'id' })
    }
    if (onResolved) {
      try { await onResolved(resolved) } catch (_e) { void _e }
    }
  })().catch((err) => {
    console.warn('[resolveRecipientNamesInBackground] failed:', err?.message || err)
  })
}

/**
 * Pre-warm the GHL contact-name cache.
 *
 * Scans the last N days of outbound emails, finds every contact_id that isn't
 * already in `ghl_contacts_cache`, and resolves up to 200 of them from GHL in
 * the background. Fires from the EmailFlows page mount (and can be reused
 * from Layout mount) so when the user opens a flow's recipient dropdown,
 * names are already populated — no more "Unknown Contact" on first view.
 *
 * Returns a promise that resolves with `{ checked, resolved }` once done.
 * Safe to call repeatedly — only uncached IDs are fetched.
 */
export async function prewarmRecipientNameCache(daysBack = 30) {
  const since = new Date()
  since.setDate(since.getDate() - daysBack)
  const sinceStr = since.toISOString().split('T')[0]

  const { data: emails } = await supabase
    .from('email_message_cache')
    .select('contact_id')
    .eq('direction', 'outbound')
    .gte('date_added', sinceStr)
    .not('contact_id', 'is', null)

  const uniqueIds = [...new Set((emails || []).map(e => e.contact_id).filter(Boolean))]
  if (uniqueIds.length === 0) return { checked: 0, resolved: 0 }

  // Check which ones are already in cache.
  const cachedIds = new Set()
  const CHUNK = 200
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    const chunk = uniqueIds.slice(i, i + CHUNK)
    const { data: cached } = await supabase
      .from('ghl_contacts_cache')
      .select('id')
      .in('id', chunk)
    for (const c of (cached || [])) cachedIds.add(c.id)
  }

  const uncached = uniqueIds.filter(id => !cachedIds.has(id))
  if (uncached.length === 0) return { checked: uniqueIds.length, resolved: 0 }

  // Batch-resolve up to 200 names in the background.
  const toResolve = uncached.slice(0, 200)
  return new Promise(resolve => {
    resolveRecipientNamesInBackground(toResolve, (resolved) => {
      resolve({ checked: uniqueIds.length, resolved: Object.keys(resolved).length })
    })
  })
}

export async function removeSubjectFromFlow(subject) {
  const { error } = await supabase.from('email_subject_meta').update({ flow_group_id: null, updated_at: new Date().toISOString() }).eq('subject', subject)
  if (error) console.error('Remove from flow failed:', error)
  else subjectMetaCache.data = null
  return !error
}
