// notify-editor-email — Supabase Edge Function
//
// Body: { notification_id: string }
// Returns: { ok, email_sent, skipped_reason? }
//
// Called fire-and-forget from notifyEditor() in the client. Each
// notification row in lib_editor_notifications represents one
// "feedback / revision_requested / assignment / source_replaced /
// approved" event. This function:
//   1. Loads the notification by id
//   2. Resolves the editor's email from lib_creative_editors
//   3. Sends an email via Resend's HTTPS API
//   4. Stamps email_sent_at on the notification so duplicate retries
//      don't re-send
//
// Idempotent on the email side: if email_sent_at is already set, we
// skip without re-sending. RESEND_API_KEY is required (set as a
// Supabase secret via the management API).
//
// Sender: noreply@send.opt.co.nz once the sending domain is verified.
// For initial setup (before domain verification) we use Resend's
// onboarding@resend.dev sandbox which only delivers to verified
// inbox addresses on the Resend account.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOWED_ORIGINS = [
  'https://sales-dashboard-ftct.onrender.com',
  'http://localhost:5173',
  'http://localhost:4173',
]
function getCorsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers?.get('origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  }
}

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// FROM address — switch to noreply@send.opt.co.nz once Ben adds the
// DNS records and verifies the domain in Resend. Until then use
// Resend's onboarding sandbox which delivers to verified accounts only.
const FROM_ADDRESS   = Deno.env.get('RESEND_FROM') || 'OPT Editor <onboarding@resend.dev>'
const PORTAL_URL     = Deno.env.get('EDITOR_PORTAL_URL') || 'https://sales-dashboard-ftct.onrender.com/editor-view'

// Per-kind copy. kind drives subject + intro line; the notification's
// title/body fields drive the rest of the email content.
const KIND_COPY: Record<string, { subject: (n: any) => string, intro: string }> = {
  feedback: {
    subject: (n) => `[OPT] Feedback: ${n.title}`,
    intro: 'You have new feedback on a submission:',
  },
  revision_requested: {
    subject: (n) => `[OPT] Revision requested: ${n.title}`,
    intro: 'A revision has been requested. See the feedback below and upload a new version when ready:',
  },
  assignment: {
    subject: (n) => `[OPT] New task: ${n.title}`,
    intro: 'You have been assigned a new task:',
  },
  reassignment: {
    subject: (n) => `[OPT] Task reassigned to you: ${n.title}`,
    intro: 'A task has been reassigned to you:',
  },
  source_replaced: {
    subject: (n) => `[OPT] Source video updated: ${n.title}`,
    intro: 'The source video for one of your tasks was replaced. Re-download the original before continuing your edit:',
  },
  approved: {
    subject: (n) => `[OPT] Approved: ${n.title}`,
    intro: 'Your submission was approved:',
  },
}

function buildHtml(notification: any, deepLink: string): string {
  const copy = KIND_COPY[notification.kind] || { subject: () => notification.title, intro: '' }
  const body = (notification.body || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c])
  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital · Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">${notification.title}</h1>
    <p style="margin:0 0 12px;font-size:14px;color:#5a5a5a;line-height:1.5;">${copy.intro}</p>
    ${body ? `<blockquote style="margin:0 0 20px;padding:12px 14px;background:#fff;border-left:3px solid #f4e14a;font-size:13.5px;color:#1a1a1a;line-height:1.55;white-space:pre-wrap;">${body}</blockquote>` : ''}
    <a href="${deepLink}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Open in editor portal →</a>
    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      Logged in via <code>${deepLink.split('?')[0]}</code>. Not expecting this email? Reply to your admin to remove your address from the editor roster.
    </div>
  </div>
</body></html>`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  const cors = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!RESEND_API_KEY) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'invalid JSON body' }, 400) }
  const notificationId = body?.notification_id
  if (!notificationId) return json({ ok: false, error: 'notification_id required' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Load notification + editor email in one go
  const { data: notif, error: nErr } = await supabase
    .from('lib_editor_notifications')
    .select('*, editor:lib_creative_editors(id, name, email)')
    .eq('id', notificationId)
    .maybeSingle()
  if (nErr || !notif) return json({ ok: false, error: `select: ${nErr?.message || 'not found'}` }, 404)

  // Idempotency — never re-send
  if (notif.email_sent_at) return json({ ok: true, email_sent: false, skipped_reason: 'already_sent' })

  const toEmail = notif.editor?.email
  if (!toEmail) return json({ ok: true, email_sent: false, skipped_reason: 'editor_has_no_email' })

  // Build the deep link. notif.link_path is something like
  // '/editor-view?task=<id>' so we just concat onto the host.
  const deepLink = notif.link_path
    ? new URL(notif.link_path, PORTAL_URL.replace(/\/editor-view.*$/, '/')).toString()
    : PORTAL_URL

  const copy = KIND_COPY[notif.kind] || { subject: () => notif.title, intro: '' }
  const subject = copy.subject(notif)
  const html = buildHtml(notif, deepLink)

  // Send via Resend
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: toEmail,
      subject,
      html,
      // Plaintext fallback so emails with HTML stripped still read sensibly.
      text: `${notif.title}\n\n${copy.intro}\n${notif.body || ''}\n\n${deepLink}`,
    }),
  })
  if (!res.ok) {
    const errBody = await res.text()
    return json({ ok: false, error: `resend HTTP ${res.status}: ${errBody.slice(0, 300)}` }, 502)
  }
  const sendResult = await res.json()

  // Stamp email_sent_at so retries skip
  await supabase
    .from('lib_editor_notifications')
    .update({ email_sent_at: new Date().toISOString() })
    .eq('id', notificationId)

  return json({
    ok: true,
    email_sent: true,
    to: toEmail,
    resend_id: sendResult?.id,
  })
})
