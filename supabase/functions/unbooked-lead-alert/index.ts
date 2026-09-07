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

  let chased = 0, waiting = 0, booked = 0
  for (const msg of hist.messages || []) {
    const text: string = msg.text || ''
    if (!isLeadPost(text) || msg.thread_ts && msg.thread_ts !== msg.ts) continue
    if (seen.has(msg.ts)) continue

    const ageMin = (now - Number(msg.ts)) / 60
    if (ageMin < GRACE_MIN) { waiting++; continue }   // still inside the grace period

    const { name, email, phone } = parseLead(text)
    if (!email && !phone) continue

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

    const who = name || email || phone
    const mention = MENTION ? `<@${MENTION}> ` : ''
    const post = await slack('chat.postMessage', {
      channel: CHANNEL,
      thread_ts: msg.ts,
      reply_broadcast: true,
      text: `${mention}:warning: no call booked for *${who}* ` +
            `${Math.round(ageMin)} minutes after this lead came through.` +
            (phone ? `\nPhone: ${phone}` : '') + (email ? `\nEmail: ${email}` : ''),
      unfurl_links: false,
    })
    if (!post.ok) { console.error('slack reply failed', post); continue }

    chased++
    await sb('lead_unbooked_alerts?on_conflict=message_ts', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ ...row, outcome: 'chased' }),
    })
  }

  return new Response(JSON.stringify({ chased, booked, waiting }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
