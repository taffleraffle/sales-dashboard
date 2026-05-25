// notify-admin-digest — Supabase Edge Function
//
// Fired by pg_cron every 15 minutes (see migration 098). Collects all
// notifications of kind='new_upload_needs_assignment' whose email has
// not yet been sent, groups them by recipient (editor_id), and sends
// one digest email per recipient listing every clip awaiting an
// editor assignment. Stamps email_sent_at on the included rows so the
// next run doesn't re-send them.
//
// Idempotent: if there are no pending rows the function returns 200
// immediately with sent=0.
//
// Body (optional): {} — no parameters required. Cron calls it with
// an empty body. Manual invocation works too for testing.

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
const FROM_ADDRESS   = Deno.env.get('RESEND_FROM') || 'OPT Editor <onboarding@resend.dev>'
const DASHBOARD_URL  = Deno.env.get('DASHBOARD_URL')
  || 'https://sales-dashboard-ftct.onrender.com'

const KIND = 'new_upload_needs_assignment'
const DIGEST_LINK = `${DASHBOARD_URL}/sales/ads/creative/library?stage=raw_unused`

function escapeHtml(s: string): string {
  return (s || '').replace(/[<>&]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;' } as Record<string, string>
  )[c])
}

function buildDigestHtml(editorName: string, notifications: any[]): string {
  const rows = notifications.map((n) => {
    const title = escapeHtml(n.title || 'Unassigned clip')
    const body  = escapeHtml(n.body || '')
    const when  = new Date(n.created_at).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e6dec8;font-size:13px;color:#1a1a1a;vertical-align:top;">
          <div style="font-weight:600;line-height:1.4;">${title}</div>
          ${body ? `<div style="font-size:12px;color:#5a5a5a;margin-top:3px;line-height:1.45;">${body}</div>` : ''}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e6dec8;font-size:11px;color:#7a7a7a;white-space:nowrap;vertical-align:top;font-family:monospace;">
          ${when}
        </td>
      </tr>`
  }).join('')

  const greeting = editorName ? `Hi ${escapeHtml(editorName.split(' ')[0])},` : 'Hi,'
  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:600px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital · Editor coordination</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">${notifications.length} new clip${notifications.length === 1 ? '' : 's'} ${notifications.length === 1 ? 'needs' : 'need'} an editor</h1>
    <p style="margin:0 0 16px;font-size:14px;color:#5a5a5a;line-height:1.55;">
      ${greeting} the following raw uploads landed in the library without an assigned editor.
      Open the dashboard to triage and assign.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 22px;background:#fff;border:1px solid #e6dec8;">
      ${rows}
    </table>
    <a href="${DIGEST_LINK}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Assign editors →</a>
    <div style="margin-top:28px;padding-top:18px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      You're receiving this because your editor profile has <code>notify_on_unassigned = TRUE</code>.
      Disable in Supabase if you'd rather not get these digests.
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

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Pull every pending row of this kind. Joined onto the editor for
  // name + email — the editor must have an email or we can't send.
  const { data: pending, error: selErr } = await supabase
    .from('lib_editor_notifications')
    .select('id, editor_id, kind, title, body, created_at, link_path, editor:lib_creative_editors(id, name, email)')
    .eq('kind', KIND)
    .is('email_sent_at', null)
    .order('created_at', { ascending: true })
    .limit(500)
  if (selErr) return json({ ok: false, error: `select: ${selErr.message}` }, 500)
  if (!pending || pending.length === 0) {
    return json({ ok: true, sent: 0, skipped_reason: 'no_pending' })
  }

  // Group by editor_id. We collapse the join into a single recipient
  // record per editor and accumulate that editor's notifications.
  const byEditor = new Map<string, { editor: any, items: any[] }>()
  for (const row of pending) {
    if (!row.editor) continue
    if (!byEditor.has(row.editor_id)) {
      byEditor.set(row.editor_id, { editor: row.editor, items: [] })
    }
    byEditor.get(row.editor_id)!.items.push(row)
  }

  const sent: any[] = []
  const skipped: any[] = []
  const errors: any[] = []

  for (const [editorId, group] of byEditor) {
    const toEmail = group.editor?.email
    if (!toEmail) {
      // Editor has no email on file — stamp them as sent (with a note)
      // so we don't queue forever. Surfaces the missing-email issue
      // back to the operator via the notification row itself.
      const ids = group.items.map(i => i.id)
      await supabase.from('lib_editor_notifications')
        .update({ email_sent_at: new Date().toISOString() })
        .in('id', ids)
      skipped.push({ editor_id: editorId, reason: 'editor_has_no_email', count: ids.length })
      continue
    }

    const subject = group.items.length === 1
      ? `[OPT] New clip needs an editor`
      : `[OPT] ${group.items.length} clips need an editor`
    const html = buildDigestHtml(group.editor.name || '', group.items)

    try {
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
        }),
      })
      if (!res.ok) {
        const errBody = await res.text()
        errors.push({ editor_id: editorId, error: `resend HTTP ${res.status}: ${errBody.slice(0, 200)}` })
        continue
      }
      // Stamp every included notification as sent.
      const ids = group.items.map(i => i.id)
      const { error: upErr } = await supabase.from('lib_editor_notifications')
        .update({ email_sent_at: new Date().toISOString() })
        .in('id', ids)
      if (upErr) {
        errors.push({ editor_id: editorId, error: `stamp failed: ${upErr.message}` })
        continue
      }
      sent.push({ editor_id: editorId, to: toEmail, count: ids.length })
    } catch (e: any) {
      errors.push({ editor_id: editorId, error: e?.message || String(e) })
    }
  }

  return json({
    ok: true,
    pending_count: pending.length,
    sent,
    skipped,
    errors,
  })
})
