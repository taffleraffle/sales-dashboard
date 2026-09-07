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
// Australian bookings go to their own channel (Ben, 06 Sep 2026): #marketing-aus-autobookings.
const AU_CHANNEL = Deno.env.get('AU_BOOKINGS_CHANNEL') || CHANNEL
const SIGNING_KEY = Deno.env.get('CALENDLY_WEBHOOK_SIGNING_KEY') || ''
const EVENT_FILTER = (Deno.env.get('CALENDLY_EVENT_FILTER') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
// Every booking is also stored in calendly_bookings (Ben, 6 Sep 2026: the
// dashboard must count Australian booked calls, which never reach GHL).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
const SB_URL = Deno.env.get('SUPABASE_URL') || ''
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
// Calendly carries none of the attribution for Australian bookings: the AU
// booking link asks for no phone number and the Facebook lead passes no UTM,
// so Phone/Campaign/Ad Creative all posted as "-" (Ben, 7 Sep 2026).
// GoHighLevel holds all three on the contact, so look them up by email.
const GHL_KEY = Deno.env.get('GHL_API_KEY') || ''
const GHL_LOCATION = Deno.env.get('GHL_LOCATION_ID') || ''

// GoHighLevel custom field ids on this location.
const CF_CAMPAIGN = '0ULgmi8o8elWOhjHCrPr'    // Campaign Name
const CF_UTM_CONTENT = 'NzZkDEZKdvzrq89aqgbi' // UTM Content, ie the ad creative
const CF_UTM_SOURCE = '1jGDQkfLL9757JxcqCaq'  // UTM Source
const CF_FB_AD = 'PZBK43JZAmhTArY4Caqp'       // scio_fb_ad_name
const CF_FB_CAMPAIGN = 'xcCGXkxSG9iaJUxP8Ax4' // scio_fb_campaign_name

type Enriched = { phone?: string; campaign?: string; creative?: string; source?: string }

/** Phone and ad attribution from the GoHighLevel contact, by email. */
async function fromGHL(email: string): Promise<Enriched> {
  if (!GHL_KEY || !GHL_LOCATION || !email) return {}
  const headers = {
    Authorization: `Bearer ${GHL_KEY}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  }
  try {
    const r = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        locationId: GHL_LOCATION, page: 1, pageLimit: 1,
        filters: [{ field: 'email', operator: 'eq', value: email }],
      }),
    })
    if (!r.ok) { console.error('ghl search failed', r.status, await r.text()); return {} }
    const hit = ((await r.json()).contacts || [])[0]
    if (!hit) return {}

    // Search results omit custom fields, so read the contact itself.
    const full = await fetch(`https://services.leadconnectorhq.com/contacts/${hit.id}`, { headers })
    const contact = full.ok ? ((await full.json()).contact || {}) : hit
    const cf: Record<string, string> = {}
    for (const f of (contact.customFields || [])) if (f?.value) cf[f.id] = String(f.value)

    return {
      phone: contact.phone || hit.phone || undefined,
      campaign: cf[CF_CAMPAIGN] || cf[CF_FB_CAMPAIGN] || undefined,
      creative: cf[CF_UTM_CONTENT] || cf[CF_FB_AD] || undefined,
      source: cf[CF_UTM_SOURCE] || contact.source || undefined,
    }
  } catch (e) {
    console.error('ghl lookup error', e)
    return {}
  }
}

async function storeBooking(inv: any, ev: any, status: string) {
  if (!SB_URL || !SB_KEY || !inv?.uri) return
  const qa: any[] = inv.questions_and_answers || []
  const phoneQ = qa.find(q => /phone|mobile|number/i.test(q.question || ''))
  const tr = inv.tracking || {}
  const clean = (v: any) => (v == null || /^_+$/.test(String(v))) ? null : String(v)
  const host = (ev.event_memberships || [])[0] || {}
  const row = {
    invitee_uri: inv.uri,
    event_uri: ev.uri || null,
    event_type_uri: ev.event_type || null,
    event_name: ev.name || null,
    status,
    start_time: ev.start_time || null,
    end_time: ev.end_time || null,
    booked_at: inv.created_at || ev.created_at || new Date().toISOString(),
    invitee_name: inv.name || null,
    invitee_email: inv.email || null,
    invitee_phone: (phoneQ && phoneQ.answer) || inv.text_reminder_number || null,
    invitee_timezone: inv.timezone || null,
    utm_source: clean(tr.utm_source), utm_medium: clean(tr.utm_medium), utm_campaign: clean(tr.utm_campaign),
    utm_content: clean(tr.utm_content), utm_term: clean(tr.utm_term),
    host_email: host.user_email || null, host_name: host.user_name || null,
    reschedule_url: inv.reschedule_url || null, cancel_url: inv.cancel_url || null,
    raw: { invitee: inv, event: ev },
    synced_at: new Date().toISOString(),
  }
  try {
    const r = await fetch(`${SB_URL}/rest/v1/calendly_bookings?on_conflict=invitee_uri`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    })
    if (!r.ok) console.error('calendly_bookings upsert failed', r.status, await r.text())
  } catch (e) { console.error('calendly_bookings upsert error', e) }
}

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
  if (payload?.event === 'invitee.canceled') {
    // Keep the row, flip the status so the dashboard drops it from bookings
    await storeBooking(payload.payload || {}, (payload.payload || {}).scheduled_event || {}, 'canceled')
    return new Response('canceled stored', { status: 200 })
  }
  if (payload?.event !== 'invitee.created') return new Response('ignored', { status: 200 })

  const inv = payload.payload || {}
  const ev = inv.scheduled_event || {}
  await storeBooking(inv, ev, 'active')
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

  // Fill whatever Calendly did not give us from the GoHighLevel contact.
  // Calendly's own values win when it has them: they describe the click that
  // produced this booking, where GoHighLevel describes the lead overall.
  const needsEnrich = phone === '-' || !tr.utm_campaign || !tr.utm_content
  const extra = needsEnrich ? await fromGHL(inv.email || '') : {}

  const lines = [
    `:calendar: new Booked Call — ${eventName || 'Calendly'}${isAU ? ' (Australia)' : ''}`,
    `Name: ${inv.name || '-'}`,
    `Email: ${inv.email || '-'}`,
    `Phone: ${phone !== '-' ? phone : (extra.phone || '-')}`,
    `Time: ${when}`,
    `Campaign: ${tr.utm_campaign || extra.campaign || '-'}`,
    `Ad Creative: ${tr.utm_content || extra.creative || '-'}`,
    `Source: ${tr.utm_source || extra.source || '-'}`,
    host ? `Host: ${host}` : '',
    inv.reschedule_url ? `Reschedule: ${inv.reschedule_url}` : '',
  ].filter(Boolean)

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: isAU ? AU_CHANNEL : CHANNEL, text: lines.join('\n'), unfurl_links: false }),
  })
  const out = await resp.json()
  if (!out.ok) { console.error('slack post failed', out); return new Response('slack error', { status: 500 }) }
  return new Response('posted', { status: 200 })
})
