// Closer Hub backend (Ben, 12 Sep 2026).
//
// The sales dashboard is a static site, so anything that needs a secret runs
// here: the shared Semrush login, "Make Channel" (through the client
// dashboard's onboarding flow), and PandaDoc contracts. Callers must be a
// logged-in closer or an admin; every write is logged to closer_hub_actions.
//
// Secrets: PANDADOC_API_KEY, SEMRUSH_USERNAME/PASSWORD, LBM_USERNAME/PASSWORD,
// AGENT_WEBHOOK_KEY, DASHBOARD_BASE (default https://dashboard.optdigital.io).
// Everything editable (conditions, signer, templates, fees) is in
// closer_hub_settings, not here.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const PANDADOC = 'https://api.pandadoc.com/public/v1'
const DASHBOARD_BASE = (Deno.env.get('DASHBOARD_BASE') || 'https://dashboard.optdigital.io').replace(/\/$/, '')

type Caller = { allowed: boolean; isAdmin: boolean; id: string; name: string; email: string }

async function whoIs(admin: any, user: any): Promise<Caller> {
  const base = { allowed: false, isAdmin: false, id: user.id, name: '', email: user.email || '' }
  const { data: p } = await admin.from('user_profiles').select('role, display_name').eq('auth_user_id', user.id).maybeSingle()
  if (p && ['admin', 'manager'].includes(p.role)) {
    return { ...base, allowed: true, isAdmin: true, name: p.display_name || base.email }
  }
  const { data: t } = await admin.from('team_members').select('name, email, role, is_active').eq('auth_user_id', user.id).maybeSingle()
  if (t && t.role === 'closer' && t.is_active !== false) {
    return { ...base, allowed: true, name: t.name || base.email, email: t.email || base.email }
  }
  return base
}

async function settings(admin: any): Promise<Record<string, string>> {
  const { data } = await admin.from('closer_hub_settings').select('key, value')
  const out: Record<string, string> = {}
  for (const row of data || []) out[row.key] = row.value || ''
  return out
}

async function log(admin: any, who: Caller, action: string, body: any, ok: boolean, result: any) {
  try {
    await admin.from('closer_hub_actions').insert({
      actor_auth_user_id: who.id, actor_name: who.name, action,
      client_name: body?.company || null, client_email: body?.email || null,
      ok, result,
    })
  } catch (_e) { /* the audit row must never break the action */ }
}

function pdHeaders(): Record<string, string> {
  const key = Deno.env.get('PANDADOC_API_KEY') || ''
  if (!key) throw new Error('PANDADOC_API_KEY is not set')
  return { Authorization: `API-Key ${key}`, 'Content-Type': 'application/json' }
}

async function pd(method: string, path: string, body?: any) {
  const r = await fetch(`${PANDADOC}${path}`, { method, headers: pdHeaders(), body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
  if (!r.ok) throw new Error(`PandaDoc ${method} ${path} ${r.status}: ${(json.detail || json.raw || text || '').toString().slice(0, 300)}`)
  return json
}

function splitName(full: string, fallbackFirst: string): [string, string] {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return [fallbackFirst, '-']
  return [parts[0], parts.slice(1).join(' ') || '-']
}

// ── actions ─────────────────────────────────────────────────────────────────

// Shared logins, one secret pair per app. Ben, 12 Sep 2026: "a login for
// Local Brand Manager and a login for Semrush".
const SHARED_LOGINS: Record<string, [string, string]> = {
  semrush: ['SEMRUSH_USERNAME', 'SEMRUSH_PASSWORD'],
  lbm: ['LBM_USERNAME', 'LBM_PASSWORD'],
}

function login(tool: string) {
  const pair = SHARED_LOGINS[tool]
  if (!pair) return { status: 400, body: { error: `no shared login called "${tool}"` } }
  const username = Deno.env.get(pair[0]) || ''
  const password = Deno.env.get(pair[1]) || ''
  if (!username || !password) return { status: 404, body: { error: 'not_set', needs: pair } }
  return { status: 200, body: { username, password } }
}

async function makeChannel(admin: any, who: Caller, body: any) {
  const key = Deno.env.get('AGENT_WEBHOOK_KEY') || ''
  if (!key) return { status: 500, body: { error: 'AGENT_WEBHOOK_KEY is not set' } }
  const company = (body.company || '').trim()
  if (!company) return { status: 400, body: { error: 'company is required' } }
  const r = await fetch(`${DASHBOARD_BASE}/webhooks/agent/client-channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Key': key },
    body: JSON.stringify({
      company, email: (body.email || '').trim(), prospect_name: (body.prospect_name || '').trim(),
      closer_email: who.email, invite_prospect: body.invite_prospect !== false, dry_run: !!body.dry_run,
    }),
  })
  const out = await r.json().catch(() => ({ error: `dashboard answered ${r.status}` }))
  if (!body.dry_run) await log(admin, who, 'make_channel', body, r.ok && !!out.ok, out)
  return { status: r.ok ? 200 : (r.status || 502), body: out }
}

// The templates in the account, for the picker. Names only; the hub shows
// them and remembers nothing.
async function templates() {
  const t = await pd('GET', '/templates?count=50')
  const list = (t.results || []).map((x: any) => ({ id: x.id, name: x.name }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
  return { status: 200, body: { templates: list } }
}

// Which role signs for OPT and which for the client, and which merge fields
// the template actually has. The account's templates disagree with each
// other ("Role 1"/"Client", "Role 1"/"Role 2", "Client"/"Opt", "Client"/
// "Creator", or "Client" alone), and the trial ones carry only generic
// Text/Date fields, so nothing is assumed: the template is asked.
async function templateShape(templateId: string) {
  const d = await pd('GET', `/templates/${templateId}/details`)
  const roles: string[] = (d.roles || []).map((r: any) => r.name).filter(Boolean)
  const clientRole = roles.find((r) => r.toLowerCase() === 'client') || roles.find((r) => r === 'Role 2') || roles[roles.length - 1] || ''
  const optRole = roles.find((r) => r !== clientRole) || ''
  const fields = new Set<string>((d.fields || []).map((f: any) => f.merge_field || f.name).filter(Boolean))
  return { roles, clientRole, optRole, fields, name: d.name || '' }
}

async function createContract(admin: any, who: Caller, body: any) {
  const s = await settings(admin)
  const offer = body.offer === 'trial' ? 'trial' : 'retainer'
  const template = (body.template || s[`template_${offer}`] || '').trim()
  if (!template) return { status: 400, body: { error: `Pick a contract template. No default is set for the ${offer} agreement.` } }
  const company = (body.company || '').trim()
  const email = (body.email || '').trim().toLowerCase()
  if (!company || !email || !email.includes('@')) return { status: 400, body: { error: 'company and a valid client email are required' } }
  const fee = String(body.fee || s[`fee_${offer}`] || '').replace(/[^0-9.]/g, '')

  // Conditions go in only when someone wrote some. Ben, 12 Sep 2026: "It's
  // adding special conditions when there aren't any special conditions."
  const standard = (s[`conditions_${offer}`] || '').trim()
  const extra = (body.extra_conditions || '').trim()
  const conditions = [standard, extra].filter(Boolean).join('\n')

  // Who signs for OPT: the person the closer picked, else the settings default.
  const optRep = (body.opt_rep_name || '').trim() || s.opt_rep_name || 'Daniel Gomez'
  const optEmail = (body.opt_rep_email || '').trim().toLowerCase() || s.opt_rep_email || 'daniel@optdigital.io'
  const [optFirst, optLast] = splitName(optRep, 'Opt')
  const [cFirst, cLast] = splitName(body.signer_name || '', 'Client')
  const docName = `${company} - Opt Digital Client Agreement`

  const shape = await templateShape(template)
  const wanted: Record<string, { value: string }> = {
    ClientName: { value: company },
    MonthlyFee: { value: fee },
    ExecutionDate: { value: new Date().toISOString().slice(0, 10) },
    OptRepName: { value: optRep },
  }
  if (conditions) wanted.SpecialConditions = { value: conditions }
  const fields: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(wanted)) {
    if (shape.fields.size === 0 || shape.fields.has(k)) { if (v.value) fields[k] = v }
  }
  if (shape.fields.has('MonthlyFee') && !fee) return { status: 400, body: { error: 'This template needs a monthly fee.' } }

  const recipients: any[] = [{ email, first_name: cFirst, last_name: cLast, role: shape.clientRole || 'Client' }]
  if (shape.optRole) recipients.unshift({ email: optEmail, first_name: optFirst, last_name: optLast, role: shape.optRole })
  const payload = { name: docName, template_uuid: template, recipients, fields }
  if (body.dry_run) return { status: 200, body: { dry_run: true, offer, template, template_name: shape.name, roles: shape.roles, payload } }

  const created = await pd('POST', '/documents', payload)
  const id = created.id
  // PandaDoc parses the template for a few seconds; the draft is usable once
  // the status leaves document.uploaded. Bounded so the request cannot hang.
  let status = created.status || 'document.uploaded'
  for (let i = 0; i < 10 && status === 'document.uploaded'; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    try { status = (await pd('GET', `/documents/${id}`)).status || status } catch { /* keep polling */ }
  }
  // The account stamps "[DEV] " on API-made documents; it would show on the
  // client's email, so it is renamed once the draft has settled.
  let renamed = false
  if (status !== 'document.uploaded') {
    try { await pd('PATCH', `/documents/${id}`, { name: docName }); renamed = true } catch { renamed = false }
  }
  const out = { ok: true, doc_id: id, status, renamed, offer, fee, conditions, name: docName,
    template, template_name: shape.name, fields_sent: Object.keys(fields),
    url: `https://app.pandadoc.com/a/#/documents/${id}`, client_email: email,
    opt_signer: shape.optRole ? optEmail : null, opt_signer_name: shape.optRole ? optRep : null }
  await log(admin, who, 'create_contract', body, true, out)
  return { status: 200, body: out }
}

async function sendContract(admin: any, who: Caller, body: any) {
  const id = (body.doc_id || '').trim()
  if (!id) return { status: 400, body: { error: 'doc_id is required' } }
  const s = await settings(admin)
  const current = await pd('GET', `/documents/${id}`)
  if (current.status === 'document.uploaded') return { status: 409, body: { error: 'still processing, try again in a few seconds' } }
  const out = await pd('POST', `/documents/${id}/send`, {
    message: s.send_message || 'Here is your agreement to review and sign.',
    subject: s.send_subject || 'Your Opt Digital agreement',
    silent: false,
  })
  const result = { ok: true, doc_id: id, status: out.status || 'document.sent', name: current.name }
  await log(admin, who, 'send_contract', { company: current.name, email: body.email }, true, result)
  return { status: 200, body: result }
}

async function contractStatus(body: any) {
  const id = (body.doc_id || '').trim()
  if (!id) return { status: 400, body: { error: 'doc_id is required' } }
  const d = await pd('GET', `/documents/${id}`)
  return { status: 200, body: { doc_id: id, status: d.status, name: d.name, url: `https://app.pandadoc.com/a/#/documents/${id}` } }
}

// ── entry ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  const pre = handleCors(req)
  if (pre) return pre
  const cors = getCorsHeaders(req)
  const reply = (status: number, body: any) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return reply(401, { error: 'Missing authorization' })
    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await callerClient.auth.getUser()
    if (!user) return reply(401, { error: 'Unauthorized' })

    const admin = createClient(supabaseUrl, serviceKey)
    const who = await whoIs(admin, user)
    if (!who.allowed) return reply(403, { error: 'Closers and admins only' })

    const body = await req.json().catch(() => ({}))
    let out: { status: number; body: any }
    switch (body.action) {
      case 'login': out = login(String(body.tool || '')); break
      case 'semrush': out = login('semrush'); break
      case 'make_channel': out = await makeChannel(admin, who, body); break
      case 'templates': out = await templates(); break
      case 'create_contract': out = await createContract(admin, who, body); break
      case 'send_contract': out = await sendContract(admin, who, body); break
      case 'contract_status': out = await contractStatus(body); break
      case 'whoami': out = { status: 200, body: { name: who.name, email: who.email, isAdmin: who.isAdmin } }; break
      default: out = { status: 400, body: { error: `unknown action "${body.action || ''}"` } }
    }
    return reply(out.status, out.body)
  } catch (e) {
    return reply(500, { error: String((e as Error)?.message || e) })
  }
})
