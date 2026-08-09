// typeform-lead-slack — Zapier-equivalent lead poster for the SEO-AI funnels.
//
// The legacy funnels post new leads into #sales-new-leads via a Zapier zap
// (Typeform trigger -> Slack). Zapier has no API to duplicate zaps, so the
// three SEO-AI forms use Typeform WEBHOOKS pointed here instead. The Slack
// message reproduces the zap's format EXACTLY, because two Optimus agents
// parse it line-by-line (offer_tagger, speed_to_lead): the text must contain
// "new Lead" and the "Name:/Email:/Phone:/Campaign:/Ad Creative:" lines.
//
// Deploy with --no-verify-jwt (Typeform cannot send Authorization headers);
// authenticity is enforced via the Typeform-Signature HMAC instead.
//
// Secrets: SLACK_BOT_TOKEN, SALES_NEW_LEADS_CHANNEL, TYPEFORM_WEBHOOK_SECRET

const SLACK_TOKEN = Deno.env.get('SLACK_BOT_TOKEN')!
const CHANNEL = Deno.env.get('SALES_NEW_LEADS_CHANNEL')!
const WEBHOOK_SECRET = Deno.env.get('TYPEFORM_WEBHOOK_SECRET') || ''

// The SEO-AI funnels. Anything else that hits this endpoint is ignored.
const AI_FORMS: Record<string, string> = {
  eOVPoEcz: 'Roofing SEO AI',
  iHmgtOfT: 'Restoration SEO AI',
  LwN93cLn: 'Home Services SEO AI',
}

async function validSignature(body: string, sig: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET) return true // secret unset: accept (form-id filter still applies)
  if (!sig) return false
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)))
  return sig === `sha256=${b64}`
}

function extract(answers: any[]): { name: string; email: string; phone: string } {
  let first = '', last = '', email = '', phone = ''
  const texts: string[] = []
  for (const a of answers || []) {
    if (a.type === 'email') email = a.email || ''
    else if (a.type === 'phone_number') phone = a.phone_number || ''
    else if (a.type === 'text' && a.text) texts.push(a.text)
  }
  // First/Last are the first two short-text answers AFTER the bottleneck
  // question; safest is the LAST two short texts (bottleneck comes first).
  if (texts.length >= 2) { first = texts[texts.length - 2]; last = texts[texts.length - 1] }
  else if (texts.length === 1) first = texts[0]
  return { name: `${first} ${last}`.trim(), email, phone }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })
  const body = await req.text()
  if (!(await validSignature(body, req.headers.get('Typeform-Signature')))) {
    return new Response('bad signature', { status: 401 })
  }
  let payload: any
  try { payload = JSON.parse(body) } catch { return new Response('bad json', { status: 400 }) }

  const fr = payload?.form_response
  const formId = fr?.form_id
  const label = AI_FORMS[formId]
  if (!fr || !label) return new Response('ignored', { status: 200 })

  const hidden = fr.hidden || {}
  const { name, email, phone } = extract(fr.answers)
  // DQ'd submissions end before the contact questions — nothing to post
  // (and the Optimus parsers skip contactless messages anyway).
  if (!email && !phone) return new Response('no contact (DQ path)', { status: 200 })

  const lines = [
    `:robot_face: new Lead — ${label} funnel`,
    `Name: ${name || '-'}`,
    `Email: ${email || '-'}`,
    `Phone: ${phone || '-'}`,
    `Campaign: ${hidden.utm_campaign || '-'}`,
    `Ad Creative: ${hidden.utm_content || '-'}`,
    `Source: ${hidden.src || '-'}${hidden.variant ? ` (variant ${hidden.variant})` : ''}`,
  ]

  const resp = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text: lines.join('\n'), unfurl_links: false }),
  })
  const out = await resp.json()
  if (!out.ok) {
    console.error('slack post failed', out)
    return new Response('slack error', { status: 500 })
  }
  return new Response('posted', { status: 200 })
})
