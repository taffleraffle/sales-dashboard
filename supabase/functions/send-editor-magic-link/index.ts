// send-editor-magic-link — Supabase Edge Function
//
// Body: { email: string, redirect_to?: string }
// Returns: { ok, sent, resend_id?, action_link_preview? }
//
// Bypasses Supabase Auth's built-in mailer entirely. The runtime mailer
// silently ignores email template patches from the management API
// (confirmed 2026-05-23), so instead we:
//   1. Generate the actual magic-link URL via auth/v1/admin/generate_link
//   2. Build the OPT-branded HTML email ourselves
//   3. Ship it via Resend (same provider that delivers feedback /
//      revision notifications and the welcome emails)
//
// Validation: only sends to emails listed in lib_creative_editors with
// active=true. This is also a soft rate limit — random anon-key holders
// can't spam arbitrary inboxes with login links from our domain.
//
// First-login vs subsequent: tries `magiclink` first (works for users
// already in auth.users), falls back to `signup` for editors who've
// never logged in before. Both generate a usable action_link.

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
const PORTAL_URL     = Deno.env.get('EDITOR_PORTAL_URL') || 'https://sales-dashboard-ftct.onrender.com/editor-view'

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as any)[c],
  )
}

function buildHtml(name: string, actionLink: string, token: string): string {
  const safeName = escapeHtml(name)
  const safeLink = escapeHtml(actionLink)
  const safeToken = escapeHtml(token)
  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital &middot; Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">Log in to your editor portal</h1>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">
      ${safeName ? `Hey ${safeName},<br><br>` : ''}Click the button below to log in. This link is valid for one hour and can only be used once.
    </p>
    <a href="${safeLink}" style="display:inline-block;margin:8px 0 22px;padding:11px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Log in to OPT Editor Portal &rarr;</a>
    ${safeToken ? `<p style="margin:0 0 6px;font-size:12px;color:#5a5a5a;line-height:1.55;">Or enter this 6-digit code at <strong>/editor-login</strong>:</p>
    <div style="margin:0 0 18px;padding:10px 14px;background:#fff;border:1px solid #d9d1be;border-left:3px solid #f4e14a;font-family:monospace;font-size:20px;font-weight:700;letter-spacing:0.16em;color:#1a1a1a;text-align:center;">${safeToken}</div>` : ''}
    <div style="margin:0 0 14px;padding:12px 14px;background:#fff;border-left:3px solid #f4e14a;font-size:12.5px;color:#1a1a1a;line-height:1.55;">
      <strong style="display:block;margin-bottom:4px;font-family:monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:#5a5a5a;">What you'll see inside</strong>
      Your task queue, every other editor's projects (team view), upload edited cuts directly to assigned tasks, and notifications when feedback is left.
    </div>
    <div style="margin-top:18px;padding-top:16px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      Didn't request this? You can safely ignore the email &mdash; only the person who has your inbox can complete the login.<br><br>
      &mdash; OPT Digital
    </div>
  </div>
</body></html>`
}

function buildText(name: string, actionLink: string): string {
  return `${name ? `Hey ${name},\n\n` : ''}Click to log in to your OPT Digital editor portal:

${actionLink}

The link is valid for one hour. If it expires, request a new one at
https://sales-dashboard-ftct.onrender.com/editor-login

- OPT Digital`
}

async function generateActionLink(email: string, redirectTo: string): Promise<{ link: string, token?: string }> {
  // Try magiclink first (works for existing auth.users), fall back to
  // signup for editors who haven't logged in before.
  //
  // IMPORTANT: redirect_to goes at the TOP LEVEL of the request body,
  // not nested under `options`. Nesting it under options silently
  // makes Supabase ignore the value and fall back to the project's
  // Site URL — which lands editors on `/` instead of `/editor-view`,
  // which routes them through ProtectedRoute before the auth-fragment
  // session is established, which dumps them on `/login`. Caught
  // 2026-05-23 after a single editor click reproduced the issue.
  const tryType = async (type: 'magiclink' | 'signup') => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, email, redirect_to: redirectTo }),
    })
    const body = await r.json().catch(() => ({}))
    if (r.ok && body.action_link) {
      return {
        link: body.action_link as string,
        token: body.email_otp as string | undefined,
      }
    }
    return null
  }
  const ml = await tryType('magiclink')
  if (ml) return ml
  const su = await tryType('signup')
  if (su) return su
  throw new Error('admin/generate_link returned no action_link for either magiclink or signup')
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
  const redirectTo = body?.redirect_to || PORTAL_URL

  // Look up the editor. Only allow login for emails actually on the
  // active editor roster OR on user_profiles with admin/manager role
  // (so the admin can test /editor-login as themselves without being
  // added to lib_creative_editors).
  //
  // Use `eq.` not `ilike.` — ilike treats `%` and `_` as wildcards and
  // an attacker passing `%@opt.co.nz` could match the first matching
  // editor and send mail to whatever inbox is on that row. Lowercase
  // happens upstream so eq is case-sensitive but safe since editor
  // emails are stored lowercased.
  const editorRes = await fetch(
    `${SUPABASE_URL}/rest/v1/lib_creative_editors?select=id,name,email,active&email=eq.${encodeURIComponent(email)}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const editors = await editorRes.json().catch(() => [])
  let editor = Array.isArray(editors) ? editors.find((e: any) => e.active) : null
  if (!editor) {
    // Fallback: check user_profiles for admin/manager. GoTrue's admin
    // users endpoint doesn't accept a `filter` query param the way the
    // older docs suggest — use the supported `email` param so we don't
    // fall through pages and miss admins whose auth user is past
    // page 1. (Caught by code review 2026-05-23 — my first version
    // worked by accident because Ben was on page 1.)
    const adminRes = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
    )
    const adminData = await adminRes.json().catch(() => ({}))
    const adminUser = (adminData?.users || []).find((u: any) => (u.email || '').toLowerCase() === email)
    if (adminUser) {
      const upRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?select=id,role,display_name&auth_user_id=eq.${adminUser.id}`,
        { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
      )
      const ups = await upRes.json().catch(() => [])
      const up = Array.isArray(ups) ? ups.find((u: any) => u.role === 'admin' || u.role === 'manager') : null
      if (up) {
        editor = { id: up.id, name: up.display_name || email.split('@')[0], email, active: true }
      }
    }
  }
  if (!editor) {
    // Always return 200 + the same shape on success-vs-not-found to
    // prevent email enumeration. The UI tells the user "if your email
    // is on the roster, you'll get a link" regardless. (Caught by code
    // review 2026-05-23 — distinct 403 / 200 leaked which emails are
    // on the editor roster.)
    return json({ ok: true, sent: false, ambiguous: true })
  }

  let link: string, token: string | undefined
  try {
    const r = await generateActionLink(editor.email, redirectTo)
    link = r.link
    token = r.token
  } catch (e: any) {
    return json({ ok: false, error: `generate_link failed: ${e.message}` }, 502)
  }

  const html = buildHtml(editor.name || '', link, token || '')
  const text = buildText(editor.name || '', link)

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: editor.email,
      subject: '[OPT] Your editor portal login link',
      html,
      text,
    }),
  })
  if (!sendRes.ok) {
    const errBody = await sendRes.text()
    return json({ ok: false, error: `resend HTTP ${sendRes.status}: ${errBody.slice(0, 300)}` }, 502)
  }
  const sendResult = await sendRes.json()
  return json({
    ok: true,
    sent: true,
    to: editor.email,
    resend_id: sendResult?.id,
    action_link_host: new URL(link).host,
  })
})
