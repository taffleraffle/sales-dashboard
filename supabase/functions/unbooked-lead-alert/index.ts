// unbooked-lead-alert — chase Australian leads that have not booked a call.
//
// Ben, 7 Sep 2026: "if a lead comes through and they don't have a meeting
// booked within 3 minutes of that lead coming through, mention me in that
// lead message in the Marketing Oz leads channel."
//
// Reads #marketing-aus-leads directly rather than hooking each lead source,
// so it covers the Typeform funnel, Facebook lead-form leads and anything
// added later with no further plumbing. For every lead post older than the
// grace period it checks calendly_bookings for that person and, if nothing is
// booked, replies IN THREAD mentioning Ben. One reply per lead, ever.
//
// Runs every minute from pg_cron. Idempotency lives in lead_unbooked_alerts.
//
// Secrets: SLACK_BOT_TOKEN, AU_LEADS_CHANNEL, MENTION_USER_ID
// Optional: LEAD_GRACE_MINUTES (default 3), LEAD_LOOKBACK_MINUTES (default 90)

const SLACK_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const CHANNEL = Deno.env.get('AU_LEADS_CHANNEL')!
const MENTION = Deno.env.get('MENTION_USER_ID') || ''
const GRACE_MIN = Number(Deno.env.get('LEAD_GRACE_MINUTES') || '3')
// Only look at recent history: an old lead that never booked is not news, and
// re-chasing yesterday's leads after a deploy would be noise.
const LOOKBACK_MIN = Number(Deno.env.get('LEAD_LOOKBACK_MINUTES') || '90')
const SB_URL = Deno.env.get('SUPABASE_URL')!
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const sb = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', ...(init.headers || {}),
    },
  })

const slack = (method: string, body: unknown) =>
  fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify(body),
  }).then(r => r.json())

/** Pull "Name:", "Email:", "Phone:" out of the lead post's own format.
 *
 * Two formats live in this channel: the Zapier "You have a new Lead - AUS
 * Funnel" post and the edge function's ":robot_face: new Lead" post. Both use
 * "Label: value" lines, so one parser covers them. Slack rewrites addresses as
 * <mailto:a@b|a@b> and URLs as <http://...|...>, so unwrap that first or the
 * email never matches anything in the database.
 */
function unwrap(v: string): string {
  return v.replace(/<mailto:([^|>]+)(\|[^>]*)?>/gi, '$1')
          .replace(/<(https?:[^|>]+)(\|[^>]*)?>/gi, '$1')
          .trim()
}

function parseLead(text: string) {
  const field = (label: string) => {
    const m = text.match(new RegExp(`^${label}:\\s*(.*)$`, 'im'))
    const v = m ? unwrap(m[1]) : ''
    return v && v !== '-' ? v : undefined
  }
  return { name: field('Name'), email: field('Email'), phone: field('Phone') }
}

const isLeadPost = (t: string) => /new Lead\b/i.test(t || '')

// Our own addresses, partners, and disposable-mail domains used by spam
// signups. Chasing these would page a human about themselves.
const INTERNAL = [
  'optdigital.io', 'opt.co.nz', 'flows.co.nz', 'scaleclients.io',
  'eyeto-ai.com', 'hilostar.com', 'mailinator.com', 'guerrillamail.com',
]

function isRealLead(name?: string, email?: string): boolean {
  const e = (email || '').toLowerCase()
  if (INTERNAL.some(d => e.endsWith('@' + d) || e.endsWith('.' + d))) return false
  if (/\btest\b|ignore/i.test(name || '')) return false
  if (/\btest\b/i.test(e)) return false
  return true
}

/** "4 minutes", "3 hours", "2 days" - a backfill should not say 6444 minutes. */
function humanAge(min: number): string {
  if (min < 90) return `${Math.round(min)} minute${Math.round(min) === 1 ? '' : 's'}`
  const h = min / 60
  if (h < 36) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** Has this person booked anything? Email first, then phone. */
async function hasBooking(email?: string, phone?: string): Promise<boolean> {
  if (email) {
    const r = await sb(`calendly_bookings?select=invitee_uri&status=eq.active` +
      `&invitee_email=ilike.${encodeURIComponent(email)}&limit=1`)
    if (r.ok && (await r.json()).length) return true
  }
  if (phone) {
    const digits = phone.replace(/\D/g, '').slice(-9)
    if (digits.length >= 8) {
      const r = await sb(`calendly_bookings?select=invitee_uri&status=eq.active` +
        `&invitee_phone=ilike.*${digits}&limit=1`)
      if (r.ok && (await r.json()).length) return true
    }
  }
  return false
}

// Deployed with --no-verify-jwt so pg_cron can call it the way the other
// scheduled functions here are called. That leaves the URL publicly
// reachable, and this one posts to Slack, so it carries its own shared
// secret rather than being open to anyone who guesses the name.
const CRON_SECRET = Deno.env.get('CRON_SECRET') || ''

Deno.serve(async (req) => {
  if (CRON_SECRET) {
    const url = new URL(req.url)
    if (url.searchParams.get('key') !== CRON_SECRET) {
      return new Response('forbidden', { status: 403 })
    }
  }
  const now = Date.now() / 1000
  const oldest = now - LOOKBACK_MIN * 60

  const hist = await slack('conversations.history', {
    channel: CHANNEL, oldest: String(oldest), limit: 200,
  })
  if (!hist.ok) {
    console.error('slack history failed', hist)
    return new Response(JSON.stringify({ error: hist.error }), { status: 500 })
  }

  // Which of these have we already handled?
  const seen = new Set<string>()
  const done = await sb('lead_unbooked_alerts?select=message_ts')
  if (done.ok) for (const r of await done.json()) seen.add(r.message_ts)

  let chased = 0, waiting = 0, booked = 0, skipped = 0
  const chasedKeys = new Set<string>()
  for (const msg of hist.messages || []) {
    const text: string = msg.text || ''
    if (!isLeadPost(text) || msg.thread_ts && msg.thread_ts !== msg.ts) continue
    if (seen.has(msg.ts)) continue

    const ageMin = (now - Number(msg.ts)) / 60
    if (ageMin < GRACE_MIN) { waiting++; continue }   // still inside the grace period

    const { name, email, phone } = parseLead(text)
    if (!email && !phone) continue
    if (!isRealLead(name, email)) { skipped++; continue }

    // The same person can post twice (a resubmitted form). Chase them once.
    const who_key = (email || phone || '').toLowerCase()
    if (chasedKeys.has(who_key)) { skipped++; continue }

    const row = {
      message_ts: msg.ts, channel_id: CHANNEL, lead_email: email || null,
      lead_phone: phone || null, lead_name: name || null,
      posted_at: new Date(Number(msg.ts) * 1000).toISOString(),
    }

    if (await hasBooking(email, phone)) {
      booked++
      await sb('lead_unbooked_alerts?on_conflict=message_ts', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ ...row, outcome: 'booked_in_time' }),
      })
      continue
    }

    // Claim the lead BEFORE posting. A run can take longer than the one minute
    // between runs, so two overlapping runs both read an empty ledger and both
    // posted: 19 leads produced 29 alerts. ignore-duplicates returns no row
    // when someone else already claimed it, so only one run posts.
    const claim = await sb('lead_unbooked_alerts?on_conflict=message_ts', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ ...row, outcome: 'chased' }),
    })
    if (!claim.ok || !(await claim.json()).length) { skipped++; continue }

    const who = name || email || phone
    const mention = MENTION ? `<@${MENTION}> ` : ''
    const post = await slack('chat.postMessage', {
      channel: CHANNEL,
      thread_ts: msg.ts,
      // Thread only. reply_broadcast also drops a copy into the channel, which
      // buries the channel under alerts (Ben, 7 Sep 2026: "reply in the thread
      // of their original lead").
      reply_broadcast: false,
      text: `${mention}:warning: no call booked for *${who}* ` +
            `${humanAge(ageMin)} after this lead came through.` +
            (phone ? `\nPhone: ${phone}` : '') + (email ? `\nEmail: ${email}` : ''),
      unfurl_links: false,
    })
    if (!post.ok) {
      // Release the claim so the next run can retry this lead.
      console.error('slack reply failed', post)
      await sb(`lead_unbooked_alerts?message_ts=eq.${msg.ts}`, { method: 'DELETE' })
      continue
    }

    chased++
    chasedKeys.add(who_key)
  }

  return new Response(JSON.stringify({ chased, booked, waiting, skipped }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
