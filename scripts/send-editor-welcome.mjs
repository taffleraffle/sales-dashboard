#!/usr/bin/env node
// One-off welcome-email sender for the editor portal rollout.
//
// Usage:
//   RESEND_API_KEY=re_... node scripts/send-editor-welcome.mjs --to ben@opt.co.nz --name Ben
//   RESEND_API_KEY=re_... node scripts/send-editor-welcome.mjs --all   # send to all editors with email != null
//
// NEVER hardcode the key. Pass via env. The key lives in the Supabase
// secrets (`RESEND_API_KEY`) and in Ben's Resend dashboard. Rotate
// after use if it's been pasted in chat.

const PORTAL = 'https://sales-dashboard-ftct.onrender.com/editor-login'
const FROM = 'OPT Editor <noreply@hurrahreviews.com>'

function buildHtml(name) {
  return `<!doctype html>
<html><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4ede2;padding:40px 16px;color:#1a1a1a;">
  <div style="max-width:540px;margin:0 auto;background:#fbf6ec;border:1px solid #d9d1be;border-top:3px solid #f4e14a;padding:32px 28px;">
    <div style="font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:#5a5a5a;margin-bottom:8px;">OPT Digital &middot; Editor portal</div>
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:500;line-height:1.3;color:#1a1a1a;">You've been added to the editor portal</h1>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">
      Hey ${name},
    </p>
    <p style="margin:0 0 14px;font-size:14px;color:#1a1a1a;line-height:1.55;">
      You've been added to OPT Digital's editor portal. From now on you'll find your video tasks, feedback, and notifications all in one place &mdash; no more chasing share links across messages.
    </p>
    <a href="${PORTAL}" style="display:inline-block;margin:8px 0 18px;padding:11px 18px;background:#1a1a1a;color:#fbf6ec;text-decoration:none;font-family:monospace;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;border-radius:2px;">Log in to the editor portal &rarr;</a>
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
    <p style="margin:20px 0 0;font-size:13px;color:#5a5a5a;line-height:1.55;">
      Questions? Reply to this email and Ben will pick it up.
    </p>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #d9d1be;font-size:11px;color:#7a7a7a;line-height:1.55;">
      &mdash; OPT Digital
    </div>
  </div>
</body></html>`
}

function buildText(name) {
  return `Hey ${name},

You've been added to OPT Digital's editor portal. From now on you'll find
your video tasks, feedback, and notifications all in one place.

Log in: ${PORTAL}

Use this email when you log in. You'll get a 6-digit code + magic link
to your inbox - no password needed.

What's inside:
  - Your task queue + every other editor's projects (team-wide view)
  - Drop finished cuts directly into the assigned task
  - See admin feedback inline (red / yellow / green status)
  - Notifications when feedback is left, a source video is replaced,
    or a task is reassigned

Questions? Reply to this email and Ben will pick it up.

- OPT Digital`
}

async function sendOne(to, name, apiKey) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to,
      subject: '[OPT] You\'ve been added to the editor portal',
      html: buildHtml(name),
      text: buildText(name),
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Resend ${res.status}: ${JSON.stringify(body)}`)
  return body
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.error('ERROR: RESEND_API_KEY env var required')
    process.exit(1)
  }
  const args = process.argv.slice(2)
  const toIdx = args.indexOf('--to')
  const nameIdx = args.indexOf('--name')
  const all = args.includes('--all')

  if (all) {
    // Pull editors from Supabase REST. Service role required.
    const svc = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!svc) { console.error('--all requires SUPABASE_SERVICE_ROLE_KEY'); process.exit(1) }
    const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co/rest/v1/lib_creative_editors?select=name,email&email=not.is.null&active=eq.true'
    const r = await fetch(url, { headers: { apikey: svc, Authorization: `Bearer ${svc}` } })
    const rows = await r.json()
    console.log(`Sending to ${rows.length} editors...`)
    for (const row of rows) {
      try {
        const res = await sendOne(row.email, row.name, apiKey)
        console.log(`  OK ${row.name} <${row.email}> -> ${res.id}`)
      } catch (e) {
        console.log(`  FAIL ${row.name} <${row.email}> -> ${e.message}`)
      }
      await new Promise(r => setTimeout(r, 500))
    }
    return
  }

  if (toIdx === -1 || nameIdx === -1) {
    console.error('Usage: --to <email> --name <name>  OR  --all')
    process.exit(1)
  }
  const result = await sendOne(args[toIdx + 1], args[nameIdx + 1], apiKey)
  console.log(`Sent to ${args[toIdx + 1]}: resend_id=${result.id}`)
}

main().catch(e => { console.error(e); process.exit(1) })
