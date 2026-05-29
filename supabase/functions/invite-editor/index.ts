// invite-editor — Supabase Edge Function
//
// Body: { email: string, name?: string }
// Returns: { ok, sent, to?, resend_id? }
//
// Fired client-side right after an admin adds a new editor to
// lib_creative_editors. Sends the OPT-branded "you've been added to the
// editor portal" welcome email via Resend, pointing the editor at
// /editor-login where they request their own magic link.
//
// Why a welcome (not a magic link): magic links expire in 1 hour. An
// invite the editor opens the next morning would be dead. The welcome
// points to /editor-login, which is permanent — they self-serve a fresh
// link there. send-editor-magic-link handles the actual login mail.
//
// Validation: only sends to an email that is on the active editor roster.
// Since the client inserts the row before invoking this, the just-added
// editor is found. This guard stops anon-key holders from spamming
// arbitrary inboxes from our domain. Returns 200 with sent=false (no
// distinct error) when the email isn't found, to avoid roster enumeration.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const ALLOWED_ORIGINS = [
  'https://sales-dashboard-ftct.onrender.com',
  'http://localhost:3000',
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
const FROM_ADDRESS   = Deno.env.get('RESEND_FROM') || 'OPT Editor Portal <noreply@hurrahreviews.com>'
// Login page (not /editor-view) — the welcome nudges them to log in, it
// doesn't carry a session. Override per-env via EDITOR_LOGIN_URL.
const LOGIN_URL      = Deno.env.get('EDITOR_LOGIN_URL') || 'https://sales-dashboard-ftct.onrender.com/editor-login'

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as any)[c],
  )
}

function buildHtml(name: string): string {
  const safeName = escapeHtml(name)
  const safeLogin = escapeHtml(LOGIN_URL)
  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital &middot; Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">You've been added to the editor portal</h1>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">
      ${safeName ? `Hey ${safeName},` : 'Hi,'}
    </p>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">
      You've been added to OPT Digital's editor portal. From now on you'll find your video tasks, feedback, and notifications all in one place &mdash; no more chasing share links across messages.
    </p>
    <a href="${safeLogin}" style="display:inline-block;margin:8px 0 18px;padding:11px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Log in to the editor portal &rarr;</a>
    <p style="margin:0 0 12px;font-size:13.5px;color:#5a5a5a;line-height:1.55;">
      Use this email address when you log in. You'll get a 6-digit code + magic link sent to your inbox &mdash; no password needed.
    </p>
    <div style="margin-top:18px;padding:14px 16px;background:#fff;border-left:3px solid #f4e14a;font-size:13px;color:#1a1a1a;line-height:1.6;">
      <strong style="display:block;margin-bottom:6px;font-family:monospace;font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;color:#5a5a5a;">What's inside</strong>
      &bull; Your task queue + every other editor's projects (team-wide view)<br>
      &bull; Drop finished cuts directly into the assigned task<br>
      &bull; See admin feedback inline (red / yellow / green status)<br>
      &bull; Get notified when feedback is left, a source video is replaced, or a task is reassigned
    </div>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      &mdash; OPT Digital
    </div>
  </div>
</body></html>`
}

function buildText(name: string): string {
  return `${name ? `Hey ${name},` : 'Hi,'}

You've been added to OPT Digital's editor portal. From now on you'll find
your video tasks, feedback, and notifications all in one place.

Log in: ${LOGIN_URL}

Use this email when you log in. You'll get a 6-digit code + magic link
to your inbox - no password needed.

What's inside:
  - Your task queue + every other editor's projects (team-wide view)
  - Drop finished cuts directly into the assigned task
  - See admin feedback inline (red / yellow / green status)
  - Notifications when feedback is left, a source video is replaced,
    or a task is reassigned

- OPT Digital`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: getCorsHeaders(req) })
  const cors = getCorsHeaders(req)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  if (!RESEND_API_KEY) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500)

  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'invalid JSON body' }, 400) }
  const email = (body?.email || '').trim().toLowerCase()
  if (!email || !email.includes('@')) return json({ ok: false, error: 'email required' }, 400)

  // Only invite emails actually on the active editor roster. eq. (not
  // ilike.) so wildcard chars in the input can't match an unintended row.
  const editorRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lib_creative_editors?select=name,email,active&email=eq.${encodeURIComponent(email)}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const editors = await editorRes.json().catch(() => [])
  const editor = Array.isArray(editors) ? editors.find((e: any) => e.active) : null
  if (!editor) {
    // Same shape as success to avoid roster enumeration.
    return json({ ok: true, sent: false, ambiguous: true })
  }

  const name = (body?.name || editor.name || '').trim()
  const html = buildHtml(name)
  const text = buildText(name)

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: editor.email,
      subject: "[OPT] You've been added to the editor portal",
      html,
      text,
    }),
  })
  if (!sendRes.ok) {
    const errBody = await sendRes.text()
    return json({ ok: false, error: `resend HTTP ${sendRes.status}: ${errBody.slice(0, 300)}` }, 502)
  }
  const sendResult = await sendRes.json()
  return json({ ok: true, sent: true, to: editor.email, resend_id: sendResult?.id })
})
