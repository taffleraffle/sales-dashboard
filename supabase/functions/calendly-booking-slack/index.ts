// calendly-booking-slack — posts every new Calendly booking into the sales
// new-leads Slack channel (Ben, 06 Sep 2026: "if they book a call on that
// Calendly, it gets put in there"). Temporary stand-in for a Zap.
//
// Calendly organisation webhook (invitee.created) -> here -> Slack. The message
// keeps the "Name:/Email:/Phone:/Campaign:/Ad Creative:" line format the
// Optimus agents already parse for the Typeform posts.
//
// Deploy with --no-verify-jwt (Calendly cannot send Authorization headers);
// authenticity is enforced via the Calendly-Webhook-Signature HMAC instead.
//
// Secrets: SLACK_BOT_TOKEN, SALES_NEW_LEADS_CHANNEL, CALENDLY_WEBHOOK_SIGNING_KEY
// Optional: CALENDLY_EVENT_FILTER (comma list; only post events whose name
// contains one of these, case-insensitive). Unset = post every booking.

const SLACK_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const CHANNEL = Deno.env.get('SALES_NEW_LEADS_CHANNEL')!
const SIGNING_KEY = Deno.env.get('CALENDLY_WEBHOOK_SIGNING_KEY') || ''
const EVENT_FILTER = (Deno.env.get('CALENDLY_EVENT_FILTER') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

async function validSignature(body: string, header: string | null): Promise<boolean> {
  if (!SIGNING_KEY) return true
  if (!header) return false
  // Header: t=<unix>,v1=<hex hmac sha256 of "<t>.<body>">
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=') as [string, string]))
  const t = parts['t'], v1 = parts['v1']
  if (!t || !v1) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`))
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
  return hex === v1
}

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-AU', { dateStyle: 'full', timeStyle: 'short', timeZone: tz || 'Australia/Sydney' }).format(new Date(iso)) + ` (${tz || 'Australia/Sydney'})`
  } catch { return iso }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })
  const body = await req.text()
  if (!(await validSignature(body, req.headers.get('Calendly-Webhook-Signature')))) {
    return new Response('bad signature', { status: 401 })
  }
  let payload: any
  try { payload = JSON.parse(body) } catch { return new Response('bad json', { status: 400 }) }
  if (payload?.event !== 'invitee.created') return new Response('ignored', { status: 200 })

  const inv = payload.payload || {}
  const ev = inv.scheduled_event || {}
  const eventName: string = ev.name || ''
  if (EVENT_FILTER.length && !EVENT_FILTER.some(f => eventName.toLowerCase().includes(f))) {
    return new Response('filtered', { status: 200 })
  }
  const qa: any[] = inv.questions_and_answers || []
  const phoneQ = qa.find(q => /phone|mobile|number/i.test(q.question || ''))
  const phone = (phoneQ && phoneQ.answer) || inv.text_reminder_number || '-'
  const tr = inv.tracking || {}
  const isAU = /aus|australia/i.test(eventName) || /-au\b|^au-/i.test(tr.utm_source || '')
  const when = fmtTime(ev.start_time, inv.timezone)
  const host = (ev.event_memberships || []).map((m: any) => m.user_name || m.user_email).filter(Boolean).join(', ')

  const lines = [
    `:calendar: new Booked Call — ${eventName || 'Calendly'}${isAU ? ' (Australia)' : ''}`,
    `Name: ${inv.name || '-'}`,
    `Email: ${inv.email || '-'}`,
    `Phone: ${phone}`,
    `Time: ${when}`,
    `Campaign: ${tr.utm_campaign || '-'}`,
    `Ad Creative: ${tr.utm_content || '-'}`,
    `Source: ${tr.utm_source || '-'}`,
    host ? `Host: ${host}` : '',
    inv.reschedule_url ? `Reschedule: ${inv.reschedule_url}` : '',
  ].filter(Boolean)

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text: lines.join('\n'), unfurl_links: false }),
  })
  const out = await resp.json()
  if (!out.ok) { console.error('slack post failed', out); return new Response('slack error', { status: 500 }) }
  return new Response('posted', { status: 200 })
})
