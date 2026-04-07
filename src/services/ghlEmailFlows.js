import { supabase } from '../lib/supabase'

const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID
const BASE_URL = 'https://services.leadconnectorhq.com'

const ghlHeaders = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
}

/**
 * Fetch all GHL workflows and cache them in ghl_workflows table.
 */
export async function fetchWorkflows() {
  const res = await fetch(`${BASE_URL}/workflows/?locationId=${GHL_LOCATION_ID}`, { headers: ghlHeaders })
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

  // Fetch email conversations (paginated)
  let convPage = 0
  let allConvos = []
  while (convPage < 20) {
    const url = `${BASE_URL}/conversations/search?locationId=${GHL_LOCATION_ID}&lastMessageType=TYPE_EMAIL&limit=100${convPage > 0 ? `&startAfterDate=${allConvos[allConvos.length - 1]?.lastMessageDate || ''}` : ''}`
    const res = await fetch(url, { headers: ghlHeaders })
    if (!res.ok) break
    const data = await res.json()
    const convos = data.conversations || []
    if (convos.length === 0) break
    allConvos = allConvos.concat(convos)
    if (convos.length < 100) break
    convPage++
  }

  onProgress(0, allConvos.length)

  // For each conversation, fetch messages and find email IDs
  const emailDetailJobs = []
  let convIdx = 0
  for (const convo of allConvos) {
    convIdx++
    onProgress(convIdx, allConvos.length)

    try {
      const msgRes = await fetch(`${BASE_URL}/conversations/${convo.id}/messages`, { headers: ghlHeaders })
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

  // Fetch full email details in batches of 10 for performance
  const rowsToUpsert = []
  for (let i = 0; i < emailDetailJobs.length; i += 10) {
    const batch = emailDetailJobs.slice(i, i + 10)
    const results = await Promise.all(batch.map(async ({ innerId, convoId }) => {
      try {
        const r = await fetch(`${BASE_URL}/conversations/messages/email/${innerId}`, { headers: ghlHeaders })
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
        const r = await fetch(`${BASE_URL}/conversations/messages/email/${id}`, { headers: ghlHeaders })
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

  // Pattern: "Name, missed you but I held the space"
  s = s.replace(/^[A-Z][a-zA-Z]+,\s+(missed you.*)$/i, '{NAME}, $1')

  // Pattern: "Name here's ..." (no comma, name at start followed by lowercase)
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(here'?s\s+.*)$/i, '{NAME} $1')

  // Pattern: "Name how fast..." / "Name how can..."
  s = s.replace(/^[A-Z][a-zA-Z]+\s+(how\s+(can|fast|do|will|much).*)$/i, '{NAME} $1')

  // Pattern: "Hey Name," / "Hi Name,"
  s = s.replace(/^(Hey|Hi|Hello)\s+[A-Z][a-zA-Z]+([,\s])/i, '$1 {NAME}$2')

  // Don't strip trailing names — too risky (matches "Reserved", "Introduction", etc.)
  // Names usually appear at start, which we already handle above.

  // Collapse repeated whitespace
  s = s.replace(/\s+/g, ' ').trim()

  return s
}

/**
 * Aggregate email stats per subject for the date range.
 * Only includes outbound workflow-sourced emails.
 */
export async function loadEmailStats(fromDate, toDate) {
  const { data } = await supabase
    .from('email_message_cache')
    .select('subject, status, source, direction, date_added, contact_id')
    .gte('date_added', fromDate)
    .lte('date_added', toDate + 'T23:59:59')
    .eq('direction', 'outbound')
    .order('date_added', { ascending: false })

  const bySubject = {}
  for (const e of (data || [])) {
    const key = normalizeSubject(e.subject)
    if (!bySubject[key]) {
      bySubject[key] = {
        subject: key,
        source: e.source,
        rawSubjects: new Set(),
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
    sent: s.sent,
    delivered: s.delivered,
    opened: s.opened,
    clicked: s.clicked,
    failed: s.failed,
    deliveryRate: s.sent > 0 ? parseFloat(((s.delivered / s.sent) * 100).toFixed(1)) : 0,
    openRate: s.delivered > 0 ? parseFloat(((s.opened / s.delivered) * 100).toFixed(1)) : 0,
    clickRate: s.delivered > 0 ? parseFloat(((s.clicked / s.delivered) * 100).toFixed(1)) : 0,
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
