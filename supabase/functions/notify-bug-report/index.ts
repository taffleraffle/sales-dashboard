// notify-bug-report — posts a freshly submitted bug report into #optimus-qa
// as Optimus, tagging Josh + Will and the requester, with every field the
// requester filled in, the screenshots, and a link back to the dashboard.
//
// Secrets (Supabase function secrets):
//   SLACK_BOT_TOKEN         — bot token for the Optimus Slack app (xoxb-…)
//   SLACK_QA_CHANNEL_ID     — target channel; defaults to #optimus-qa
//   SLACK_MENTION_USER_IDS  — comma-separated Slack member IDs to tag on every
//                             report (Josh + Will). Falls back to plain text.
//   SLACK_USER_MAP          — optional JSON {"Ben":"U0…","Ron":"U0…"} mapping
//                             dashboard display names to Slack member IDs so
//                             the requester gets a real @-mention.
//   DASHBOARD_URL           — base URL for the "view in dashboard" link.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders, handleCors } from '../_shared/cors.ts'

const DEFAULT_CHANNEL = 'C0AJPQQP8FL' // #optimus-qa
const DEFAULT_DASHBOARD_URL = 'https://sales-dashboard-ftct.onrender.com'

const URGENCY_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', critical: ':rotating_light: CRITICAL',
}
const REPRO_LABELS: Record<string, string> = {
  every_time: 'Yes, every time', sometimes: 'Sometimes', once: 'Happened once',
}

function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const slackToken = Deno.env.get('SLACK_BOT_TOKEN')
    if (!slackToken) return json({ error: 'SLACK_BOT_TOKEN secret is not configured' }, 500, req)

    // Caller must be a logged-in dashboard user
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401, req)
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user: caller } } = await callerClient.auth.getUser()
    if (!caller) return json({ error: 'Unauthorized' }, 401, req)

    const { report_id } = await req.json()
    if (!report_id) return json({ error: 'report_id is required' }, 400, req)

    const admin = createClient(supabaseUrl, serviceKey)
    const { data: report, error: repErr } = await admin
      .from('bug_reports').select('*').eq('id', report_id).single()
    if (repErr || !report) return json({ error: 'Report not found' }, 404, req)

    // Signed URLs so Slack can render the screenshots (7 days)
    let screenshots: { name: string; url: string }[] = []
    if (report.screenshot_paths?.length) {
      const { data: signed } = await admin.storage
        .from('bug-screenshots')
        .createSignedUrls(report.screenshot_paths, 604800)
      screenshots = (signed || [])
        .map((s, i) => ({ name: report.screenshot_paths[i].split('/').pop() ?? 'screenshot', url: s.signedUrl }))
        .filter((s) => s.url)
    }

    // ── Build the Slack message ──────────────────────────────────────────
    const mentionIds = (Deno.env.get('SLACK_MENTION_USER_IDS') || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const teamMention = mentionIds.length
      ? mentionIds.map((id) => `<@${id}>`).join(' & ')
      : '@Josh & @Will'

    let userMap: Record<string, string> = {}
    try { userMap = JSON.parse(Deno.env.get('SLACK_USER_MAP') || '{}') } catch { /* optional */ }
    const requesterMention = userMap[report.requester_name]
      ? `<@${userMap[report.requester_name]}>`
      : `*${report.requester_name}*`

    const dashboardUrl = `${Deno.env.get('DASHBOARD_URL') || DEFAULT_DASHBOARD_URL}/sales/troubleshoot/${report.id}`

    const headline = `${teamMention}: ${requesterMention} has requested a new fix for the dashboard. Here is all the listed info down below:`

    const metaLines = [
      `*Urgency:* ${URGENCY_LABELS[report.urgency] || report.urgency}`,
      report.page_location ? `*Where:* ${report.page_location}` : null,
      report.reproducibility ? `*Reproducible:* ${REPRO_LABELS[report.reproducibility] || report.reproducibility}` : null,
      report.browser_device ? `*Browser/device:* ${report.browser_device}` : null,
    ].filter(Boolean).join('\n')

    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: headline } },
      { type: 'header', text: { type: 'plain_text', text: report.title.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: metaLines } },
    ]
    const addText = (label: string, value: string | null) => {
      if (value) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${label}*\n${value.slice(0, 2900)}` } })
    }
    addText('What happened', report.what_happened)
    addText('Expected behavior', report.expected_behavior)
    addText('Steps to reproduce', report.steps_to_reproduce)
    addText('Extra notes', report.extra_notes)
    for (const shot of screenshots) {
      blocks.push({
        type: 'image',
        image_url: shot.url,
        alt_text: shot.name,
        title: { type: 'plain_text', text: shot.name.slice(0, 150) },
      })
    }
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Open in dashboard', emoji: true },
        url: dashboardUrl,
        style: 'primary',
      }],
    })
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Report ID \`${report.id}\` · zip download for Claude Code available on the dashboard page` }],
    })

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${slackToken}` },
      body: JSON.stringify({
        channel: Deno.env.get('SLACK_QA_CHANNEL_ID') || DEFAULT_CHANNEL,
        text: `New dashboard fix request from ${report.requester_name}: ${report.title}`,
        blocks,
        unfurl_links: false,
      }),
    })
    const slackData = await slackRes.json()
    if (!slackData.ok) return json({ error: `Slack API error: ${slackData.error}` }, 502, req)

    await admin.from('bug_reports')
      .update({ slack_ts: slackData.ts, notified_at: new Date().toISOString() })
      .eq('id', report.id)

    return json({ success: true, slack_ts: slackData.ts }, 200, req)
  } catch (err) {
    return json({ error: (err as Error).message }, 500, req)
  }
})
