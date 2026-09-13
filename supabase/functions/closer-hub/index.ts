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
async function templates(admin: any) {
  const t = await pd('GET', '/templates?count=50')
  const all = (t.results || []).map((x: any) => ({ id: x.id, name: x.name }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
  // Ben, 12 Sep 2026: only the templates in use, marked ACTIVE in PandaDoc.
  // The API lists archived ones too, so the name is the switch.
  const st = await settings(admin)
  const allow = new Set((st.template_active_ids || '').split(',').map((x) => x.trim()).filter(Boolean))
  const active = all.filter((x: any) => /\bACTIVE\b/i.test(x.name) || allow.has(x.id))
  // Agreements kept as our own tagged Word files (the Australian one) show
  // in the picker too; their id is "file:<path in the closer-hub bucket>".
  const files = Object.entries(st).filter(([k, v]) => k.startsWith('template_') && String(v || '').startsWith('file:'))
    .map(([k, v]) => ({ id: String(v), name: String(st[`${k}_label`] || (k.includes('_au') ? 'ACTIVE Retainer AU - Local SEO Client Agreement (AUD)' : String(v).slice(5))) }))
  const seen = new Set<string>()
  const list = [...(active.length ? active : all), ...files].filter((x: any) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
  return { status: 200, body: { templates: list, all_count: all.length } }
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
  // Signature boxes per role. PandaDoc's details answer assigns a field to a
  // role by id, so map the id back to the name.
  const roleName: Record<string, string> = {}
  for (const r of d.roles || []) roleName[r.id] = r.name
  const signatures: Record<string, number> = {}
  for (const f of d.fields || []) {
    if (f.type !== 'signature') continue
    const a = f.assigned_to || {}
    const name = a.role_name || roleName[a.id] || a.name || '?'
    signatures[name] = (signatures[name] || 0) + 1
  }
  return { roles, clientRole, optRole, fields, signatures, name: d.name || '' }
}

// Upload one of our tagged Word files to PandaDoc as a new document. The
// file lives in the private closer-hub bucket on this project.
async function createFromFile(path: string, data: any) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const f = await fetch(`${supabaseUrl}/storage/v1/object/closer-hub/${path}`, { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } })
  if (!f.ok) throw new Error(`agreement file ${path} not found in storage (${f.status})`)
  const blob = await f.blob()
  const form = new FormData()
  form.append('file', blob, path.split('/').pop() || 'agreement.docx')
  form.append('data', JSON.stringify(data))
  const key = Deno.env.get('PANDADOC_API_KEY') || ''
  const r = await fetch(`${PANDADOC}/documents`, { method: 'POST', headers: { Authorization: `API-Key ${key}` }, body: form })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`PandaDoc upload ${r.status}: ${(j.detail || JSON.stringify(j)).toString().slice(0, 300)}`)
  const id = j.id
  let status = j.status || 'document.uploaded'
  // A file upload takes PandaDoc longer to parse than a template does; wait up
  // to about 100 seconds, then hand back whatever state it is in.
  for (let i = 0; i < 20 && status === 'document.uploaded'; i++) {
    await new Promise((res) => setTimeout(res, 5000))
    try { status = (await pd('GET', `/documents/${id}`)).status || status } catch { /* keep polling */ }
  }
  let renamed = false
  if (status !== 'document.uploaded') {
    try { await pd('PATCH', `/documents/${id}`, { name: data.name }); renamed = true } catch { renamed = false }
  }
  return { id, status, renamed, fields: data.fields }
}

async function createContract(admin: any, who: Caller, body: any) {
  const s = await settings(admin)
  const offer = body.offer === 'trial' ? 'trial' : 'retainer'
  const region = (body.region || '').toLowerCase()
  const template = (body.template || (region === 'au' ? s[`template_${offer}_au`] : '') || s[`template_${offer}`] || '').trim()
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

  // A file-based agreement: our own tagged Word file, uploaded to PandaDoc
  // per deal with the fields filled. The tags carry the roles (Closer /
  // Client), so no template lookup is needed.
  if (template.startsWith('file:')) {
    if (body.dry_run) return { status: 200, body: { dry_run: true, offer, template, template_name: 'file upload', roles: ['Closer', 'Client'],
      payload: { name: docName, recipients: [{ email: optEmail, role: 'Closer' }, { email, role: 'Client' }], fields: { ClientName: company, MonthlyFee: fee, ExecutionDate: 'today', OptRepName: optRep, ...(conditions ? { SpecialConditions: conditions } : {}) } } } }
    const out = await createFromFile(template.slice(5), {
      name: docName,
      recipients: [
        { email: optEmail, first_name: optFirst, last_name: optLast, role: 'Closer' },
        { email, first_name: cFirst, last_name: cLast, role: 'Client' },
      ],
      // PandaDoc insists every tag in the file is declared here, the client's
      // own fields and both signature boxes included, or processing fails.
      fields: {
        ClientName: { value: company, role: 'Closer' }, MonthlyFee: { value: fee, role: 'Closer' },
        SpecialConditions: { value: conditions || '', role: 'Closer' }, OptRepName: { value: optRep, role: 'Closer' },
        OptSignature: { role: 'Closer' },
        ExecutionDate: { value: new Date().toISOString().slice(0, 10), role: 'Client' },
        AuthorisedName: { value: '', role: 'Client' }, ClientSignature: { role: 'Client' },
      },
      parse_form_fields: false,
    })
    const result = { ok: true, doc_id: out.id, status: out.status, renamed: out.renamed, offer, fee, conditions, name: docName, template,
      template_name: 'Local SEO Client Agreement (AUD)', fields_sent: ['ClientName', 'MonthlyFee', 'ExecutionDate', 'OptRepName'].concat(conditions ? ['SpecialConditions'] : []),
      url: `https://app.pandadoc.com/a/#/documents/${out.id}`, client_email: email, opt_signer: optEmail, opt_signer_name: optRep }
    await log(admin, who, 'create_contract', body, true, result)
    return { status: 200, body: result }
  }
  const shape = await templateShape(template)
  // A contract one side cannot sign is not a contract. Ben's hand-made AU
  // template (13 Sep) had only the client's signature box; say so plainly
  // rather than send it.
  const missing = [
    ...(shape.clientRole && !shape.signatures[shape.clientRole] ? ['the client'] : []),
    ...(shape.optRole && !shape.signatures[shape.optRole] ? ['OPT'] : []),
  ]
  if (missing.length) return { status: 400, body: { error: `The template "${shape.name.trim()}" has no signature box for ${missing.join(' or ')} (roles ${shape.roles.join(' / ')}). Add one in PandaDoc's template editor, or pick another template.`, code: 'no_signature_box', signatures: shape.signatures } }
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
  let out: any
  try {
    out = await pd('POST', `/documents/${id}/send`, {
      message: s.send_message || 'Here is your agreement to review and sign.',
      subject: s.send_subject || 'Your Opt Digital agreement',
      silent: false,
    })
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    // A sandbox API key may only send to members of the organisation.
    // PandaDoc answers 403 "not allowed to send documents outside of your
    // organization". The draft is fine; it just has to be sent from PandaDoc
    // itself until a production key is in place.
    if (/outside of your organization/i.test(msg)) {
      return { status: 403, body: { error: 'PandaDoc will not send from the API with this key (a sandbox key can only send inside the organisation). The draft is ready: open it in PandaDoc and send it from there. A production API key fixes this for good.', code: 'outside_org', url: `https://app.pandadoc.com/a/#/documents/${id}` } }
    }
    throw e
  }
  const result = { ok: true, doc_id: id, status: out.status || 'document.sent', name: current.name }
  await log(admin, who, 'send_contract', { company: current.name, email: body.email }, true, result)
  return { status: 200, body: result }
}

// Where the agreement is up to. Ben, 12 Sep 2026: "see if they've opened
// the contract, if they have not opened the contract, and get a bit more of
// a feel for it". PandaDoc's status walks draft -> sent -> viewed ->
// completed (or declined / voided); the details call adds who has signed.
async function contractStatus(body: any) {
  const id = (body.doc_id || '').trim()
  if (!id) return { status: 400, body: { error: 'doc_id is required' } }
  const d = await pd('GET', `/documents/${id}/details`)
  const status = String(d.status || '')
  const recipients = (d.recipients || []).map((r: any) => ({
    email: r.email, role: r.role, has_completed: !!r.has_completed, signing_order: r.signing_order ?? null,
    shared_link: r.shared_link || null,
  }))
  // The client's own signing link, so the closer can text it instead of
  // relying on PandaDoc's email. PandaDoc issues it once the document is sent.
  const clientRole = (r: any) => ['client', 'role 2'].includes(String(r.role || '').toLowerCase())
  const signing_link = (recipients.find((r: any) => clientRole(r) && r.shared_link) || recipients.find((r: any) => r.shared_link && !['role 1', 'opt', 'creator'].includes(String(r.role || '').toLowerCase())))?.shared_link || null
  const opened = ['document.viewed', 'document.completed', 'document.waiting_approval', 'document.approved', 'document.waiting_pay', 'document.paid'].includes(status)
  const word = status === 'document.completed' ? 'signed'
    : status === 'document.declined' ? 'declined'
    : status === 'document.voided' ? 'voided'
    : opened ? 'opened'
    : status === 'document.sent' ? 'sent, not opened yet'
    : status === 'document.draft' ? 'drafted, not sent'
    : status.replace('document.', '')
  return { status: 200, body: { doc_id: id, status, word, opened, signing_link, name: d.name, date_modified: d.date_modified || null,
    date_sent: d.date_sent || null, date_completed: d.date_completed || null, recipients,
    url: `https://app.pandadoc.com/a/#/documents/${id}` } }
}

// ── checklist automations ───────────────────────────────────────────────────
// Ben, 12 Sep 2026: "automate what we can with payment links / pages,
// contract etc and tickboxes for things".

// The Commas (FanBasis) products, so an admin can pick which one is the
// trial and which the retainer, and the closer gets the right checkout link.
async function payProducts() {
  const key = Deno.env.get('FANBASIS_API_KEY') || ''
  if (!key) return { status: 404, body: { error: 'FANBASIS_API_KEY is not set' } }
  const r = await fetch('https://www.fanbasis.com/public-api/products?per_page=100', { headers: { 'x-api-key': key } })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return { status: 502, body: { error: `Commas answered ${r.status}` } }
  const items: any[] = (j.data && (j.data.data || j.data.products)) || j.products || []
  const products = items.map((x: any) => {
    const url = Object.entries(x).find(([k, v]) => typeof v === 'string' && /^https?:\/\//.test(v as string) && /url|link|checkout|page/i.test(k))?.[1]
      || Object.values(x).find((v) => typeof v === 'string' && /^https?:\/\/.*(checkout|fanbasis)/i.test(v as string)) || ''
    return { id: String(x.id ?? x.uuid ?? ''), name: String(x.name || x.title || ''), price: x.price ?? x.amount ?? x.pricing ?? null, url,
      keys: Object.keys(x).slice(0, 40) }
  })
  return { status: 200, body: { products } }
}

// A Stripe checkout for this client, when Commas will not work for them.
// One-off for a trial, monthly subscription for a retainer. The session
// carries the client's email, so the webhook that records the payment
// matches it to the deal automatically.
async function stripeLink(admin: any, who: Caller, body: any) {
  const key = Deno.env.get('STRIPE_SECRET_KEY') || ''
  if (!key) return { status: 404, body: { error: 'STRIPE_SECRET_KEY is not set' } }
  const s = await settings(admin)
  const email = (body.email || '').trim().toLowerCase()
  const company = (body.company || '').trim()
  const offer = body.offer === 'trial' ? 'trial' : 'retainer'
  const amount = Math.round(parseFloat(String(body.fee || s[`fee_${offer}`] || '0').replace(/[^0-9.]/g, '')) * 100)
  if (!email.includes('@') || !company || !amount) return { status: 400, body: { error: 'company, client email and a fee are required' } }
  const currency = (body.currency || s.stripe_currency || 'usd').toLowerCase()
  const form = new URLSearchParams()
  form.set('mode', offer === 'trial' ? 'payment' : 'subscription')
  form.set('customer_email', email)
  form.set('success_url', 'https://sales-dashboard-ftct.onrender.com/sales/closer-hub?paid=1')
  form.set('cancel_url', 'https://sales-dashboard-ftct.onrender.com/sales/closer-hub')
  form.set('line_items[0][quantity]', '1')
  form.set('line_items[0][price_data][currency]', currency)
  form.set('line_items[0][price_data][unit_amount]', String(amount))
  form.set('line_items[0][price_data][product_data][name]', offer === 'trial' ? `Opt Digital 14-day trial: ${company}` : `Opt Digital monthly retainer: ${company}`)
  if (offer !== 'trial') form.set('line_items[0][price_data][recurring][interval]', 'month')
  form.set('metadata[company]', company)
  form.set('metadata[offer]', offer)
  form.set('metadata[closer]', who.email)
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return { status: 502, body: { error: j?.error?.message || `Stripe answered ${r.status}` } }
  const out = { ok: true, url: j.url, session_id: j.id, amount: amount / 100, currency, mode: form.get('mode') }
  await log(admin, who, 'stripe_link', body, true, out)
  return { status: 200, body: out }
}

// Has this client paid since the deal was opened? Stripe and Commas both land
// in `payments` through their webhooks, keyed by the customer's email.
async function paymentCheck(admin: any, body: any) {
  const email = (body.email || '').trim().toLowerCase()
  if (!email.includes('@')) return { status: 400, body: { error: 'email required' } }
  const since = body.since || new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data } = await admin.from('payments').select('source, amount, currency, payment_date, created_at, description')
    .ilike('customer_email', email).gte('created_at', since).order('created_at', { ascending: false }).limit(3)
  const hit = (data || [])[0]
  return { status: 200, body: { paid: !!hit, payment: hit || null } }
}

// Move the client's GoHighLevel card into the win stage for the deal type.
// This is "moving it", one of the two things that announce a close, so it
// only acts on an exact match: one contact by email, one open deal in a
// SCIO pipeline. Anything else is listed and nothing moves.
const GHL_PIPELINES: Record<string, { region: string; closed: string; maps: string }> = {
  ZN1DW9S9qS540PNAXSxa: { region: 'US', closed: 'b7dc415a-f0a4-41dd-b113-741929eb517b', maps: '62986bfd-7f23-4089-a6e5-f68527bbc750' },
  Ab4csK3mR419FsgyqUE2: { region: 'AUS', closed: 'c654af24-25eb-4a09-981a-fd23ba5d0495', maps: '0c525201-de53-4d3c-9424-38be21da5f52' },
}
const WIN_STAGES = new Set(Object.values(GHL_PIPELINES).flatMap((p) => [p.closed, p.maps, '0f9d5445-37da-487b-8925-6e0d7d35386b', '441fcf18-e187-4b04-b5b9-8b8dea1250a4']))

async function ghl(path: string, init: RequestInit = {}) {
  const key = Deno.env.get('CLOSER_HUB_GHL_API_KEY') || Deno.env.get('GHL_API_KEY') || ''
  if (!key) throw new Error('GHL_API_KEY is not set')
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
    ...init, headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`GoHighLevel ${path.split('?')[0]} ${r.status}: ${(j.message || j.error || '').toString().slice(0, 160)}`)
  return j
}

// Find the lead in GoHighLevel so step 1 fills itself in. Ben, 12 Sep 2026:
// "search for the lead in GoHighLevel to populate. If there's no lead, we
// can manually fill that."
async function ghlSearch(body: any) {
  const loc = Deno.env.get('GHL_LOCATION_ID') || ''
  const q = (body.query || '').trim()
  if (q.length < 2) return { status: 400, body: { error: 'type a name, company or email' } }
  // POST search matches names, companies and emails together (GET query
  // misses a company with no contact name on it).
  const found = await ghl('/contacts/search', { method: 'POST', body: JSON.stringify({ locationId: loc, query: q, page: 1, pageLimit: 8 }) })
  const contacts = (found.contacts || []).map((c: any) => ({
    id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.contactName || c.name || '',
    company: c.companyName || '', email: c.email || '', phone: c.phone || '', country: c.country || '',
    tags: (c.tags || []).slice(0, 6),
  }))
  return { status: 200, body: { contacts, total: found.total ?? contacts.length } }
}

async function ghlMove(admin: any, who: Caller, body: any) {
  const loc = Deno.env.get('GHL_LOCATION_ID') || ''
  const email = (body.email || '').trim().toLowerCase()
  const offer = body.offer === 'trial' ? 'trial' : 'retainer'
  if (!email.includes('@') && !body.contact_id) return { status: 400, body: { error: 'client email required' } }
  // The contact picked in step 1 wins; otherwise an exact email match.
  let contacts: any[] = []
  if (body.contact_id) {
    contacts = [{ id: String(body.contact_id) }]
  } else {
    const found = await ghl(`/contacts/?locationId=${encodeURIComponent(loc)}&query=${encodeURIComponent(email)}&limit=20`)
    contacts = (found.contacts || []).filter((c: any) => (c.email || '').toLowerCase() === email)
  }
  if (contacts.length === 0) return { status: 200, body: { ok: false, reason: 'no_contact', message: `No GoHighLevel contact has the email ${email}.` } }
  const deals: any[] = []
  for (const c of contacts) {
    const r = await ghl(`/opportunities/search?location_id=${encodeURIComponent(loc)}&contact_id=${encodeURIComponent(c.id)}&limit=20`)
    for (const o of r.opportunities || []) {
      if (!GHL_PIPELINES[o.pipelineId]) continue
      deals.push({ id: o.id, name: o.name, pipelineId: o.pipelineId, region: GHL_PIPELINES[o.pipelineId].region, stageId: o.pipelineStageId, status: o.status, contact: c.id })
    }
  }
  const already = deals.filter((d) => WIN_STAGES.has(d.stageId))
  if (already.length) return { status: 200, body: { ok: true, already: true, deal: already[0], message: `${already[0].name || 'The deal'} is already in a win stage (${already[0].region}). Nothing moved.` } }
  const open = deals.filter((d) => d.status === 'open')
  if (open.length !== 1) return { status: 200, body: { ok: false, reason: open.length ? 'ambiguous' : 'no_deal', candidates: open,
    message: open.length ? `${open.length} open deals match; move it by hand.` : `The contact has no open deal in a SCIO pipeline.` } }
  const d = open[0]
  const target = offer === 'trial' ? GHL_PIPELINES[d.pipelineId].closed : GHL_PIPELINES[d.pipelineId].maps
  if (body.dry_run) return { status: 200, body: { ok: true, dry_run: true, deal: d, target, stage: offer === 'trial' ? 'Closed' : 'New Map Closes' } }
  const moved = await ghl(`/opportunities/${d.id}`, { method: 'PUT', body: JSON.stringify({ pipelineId: d.pipelineId, pipelineStageId: target }) })
  const o = moved.opportunity || moved
  const out = { ok: true, moved: true, deal: { ...d, stageId: o.pipelineStageId || target }, stage: offer === 'trial' ? 'Closed' : 'New Map Closes', region: d.region }
  await log(admin, who, 'ghl_move', body, true, out)
  return { status: 200, body: out }
}

// What the client dashboard knows about a finished deal: the assignment,
// the contract link on it, the account manager and the onboarding call.
async function dealStatus(body: any) {
  const key = Deno.env.get('AGENT_WEBHOOK_KEY') || ''
  if (!key) return { status: 500, body: { error: 'AGENT_WEBHOOK_KEY is not set' } }
  const q = new URLSearchParams({ email: (body.email || '').trim().toLowerCase(), company: (body.company || '').trim() })
  const r = await fetch(`${DASHBOARD_BASE}/webhooks/agent/deal-status?${q}`, { headers: { 'X-Webhook-Key': key } })
  const out = await r.json().catch(() => ({ error: `dashboard answered ${r.status}` }))
  return { status: r.ok ? 200 : (r.status || 502), body: out }
}

// A referral's card from the client dashboard: contact, website, every GMB.
async function clientCard(body: any) {
  const key = Deno.env.get('AGENT_WEBHOOK_KEY') || ''
  if (!key) return { status: 500, body: { error: 'AGENT_WEBHOOK_KEY is not set' } }
  const q = new URLSearchParams({ company: (body.company || '').trim(), email: (body.email || '').trim().toLowerCase() })
  const r = await fetch(`${DASHBOARD_BASE}/webhooks/agent/client-card?${q}`, { headers: { 'X-Webhook-Key': key } })
  const out = await r.json().catch(() => ({ error: `dashboard answered ${r.status}` }))
  return { status: r.ok ? 200 : (r.status || 502), body: out }
}

// ── post-call notes ─────────────────────────────────────────────────────────
// Ben, 13 Sep 2026: "take a Fathom transcript and then spit out something
// like this". The closer pastes the Fathom share link (or the transcript);
// the meeting is found through Fathom's API, the transcript goes to Claude
// with Ben's template as the rules, and the notes come back ready to drop in
// the client's Slack channel.

const NOTES_SYSTEM = `You write post-call notes for OPT Digital, a local SEO agency, from the transcript of a sales call that closed (or is about to). The account manager who reads them was not on the call and must be able to onboard the client from these notes alone.

Write in plain English. No em dashes anywhere; use commas, full stops or a colon instead. No headings other than the ones below. No preamble, no sign-off, no commentary about the transcript itself.

Output EXACTLY this shape, as Slack-ready text (bold with single asterisks, one blank line between blocks):

Name: <client's full name>
Phone Number: <number, or "not captured on call">
Email: <email>
OB Call Booked: <day, date and time with timezone, or "not booked yet">
Website: <url>
Trial: <Y or N>
Scope/Info:

*Personality*
<one paragraph: how they think, decide and communicate; what they respond to; who else is involved in decisions>

*Past Experience*
<one or two paragraphs: the business, size, revenue, lead sources, ad spend, prior agencies or vendors and how that went, assets they already have and what those have produced. Include other businesses they own if mentioned>

*Concerns*
<one paragraph: objections raised and what settled them, what they need to see, anything they are wary of>

*Goals*
<one paragraph: the numbers they want, the channels, the timeframe, expansion plans>

*Priorities & Action Points*
<a bulleted list, one line each, starting with the technical and structural fixes, then content, reviews, citations, tracking, then admin items such as documents to send and the onboarding form>
<the last two bullets are always:>
Trial scope: <what the trial covers, price, length, what success looks like. If it is a retainer with no trial, say "No trial: retainer from day one" and describe month one>
Post-trial roadmap (do not scope into trial): <what comes after, price, what was deliberately parked and why>

<then, only if something is missing:>
Gaps to fill before the OB call: <one line per missing item, e.g. no phone number captured, partner's surname not confirmed>

Rules: header lines are one short line each; any doubt about them goes in the Gaps line, not the header. The closer is whoever the transcript shows speaking for OPT; the deal record's closer name is only a hint. Never invent facts. If the transcript does not cover something, say so in the Gaps line rather than guessing. Keep numbers exactly as spoken (revenue, ad spend, review counts, prices). Name the people (client, partner, closer) as they are named on the call. Use the deal details supplied below for the header where the transcript is silent.`

const FATHOM = 'https://api.fathom.ai/external/v1'
async function fathomGet(path: string) {
  const key = Deno.env.get('FATHOM_API_KEY') || ''
  if (!key) throw new Error('FATHOM_API_KEY is not set')
  const r = await fetch(`${FATHOM}${path}`, { headers: { 'X-Api-Key': key } })
  if (r.status === 429) throw new Error('Fathom is rate-limiting us for a minute. Wait a moment and try again, or paste the transcript.')
  if (!r.ok) throw new Error(`Fathom answered ${r.status}`)
  return r.json()
}

// Find the recording behind a share link. The list is paged newest first
// without transcripts (cheap, 60 calls a minute); the client's email narrows
// it to their own meetings first. The transcript is then one call by
// recording id (that endpoint allows 10 a minute).
async function fathomTranscript(shareUrl: string, invitee = ''): Promise<{ title: string; text: string; started: string } | null> {
  const want = shareUrl.trim().split('?')[0].replace(/\/$/, '')
  const since = new Date(Date.now() - 45 * 86400000).toISOString()
  const same = (m: any) => String(m.share_url || '').split('?')[0].replace(/\/$/, '') === want
  let hit: any = null
  if (invitee) {
    const j: any = await fathomGet(`/meetings?${new URLSearchParams({ created_after: since, 'calendar_invitees[]': invitee })}`)
    hit = (j.items || []).find(same) || null
  }
  let cursor = ''
  for (let page = 0; page < 30 && !hit; page++) {
    const q = new URLSearchParams({ created_after: since })
    if (cursor) q.set('cursor', cursor)
    const j: any = await fathomGet(`/meetings?${q}`)
    hit = (j.items || []).find(same) || null
    cursor = j.next_cursor || ''
    if (!cursor) break
  }
  if (!hit) return null
  const t: any = await fathomGet(`/recordings/${hit.recording_id}/transcript`)
  const lines = (t.transcript || []).map((x: any) => `${x.timestamp || ''} ${x.speaker?.display_name || 'Unknown'}: ${x.text || ''}`.trim())
  return { title: hit.title || hit.meeting_title || '', text: lines.join('\n'), started: hit.recording_start_time || hit.scheduled_start_time || '' }
}

async function callNotes(admin: any, who: Caller, body: any) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') || ''
  if (!apiKey) return { status: 500, body: { error: 'ANTHROPIC_API_KEY is not set' } }
  const s = await settings(admin)
  let transcript = String(body.transcript || '').trim()
  let title = ''
  if (!transcript && body.fathom_url) {
    const m = await fathomTranscript(String(body.fathom_url), String(body.deal?.email || ''))
    if (!m) return { status: 404, body: { error: 'That Fathom link was not found among the last 45 days of recordings. Check the link, or paste the transcript instead.' } }
    if (!m.text) return { status: 422, body: { error: `Fathom has no transcript yet for "${m.title}". Give it a few minutes, or paste the transcript.` } }
    transcript = m.text; title = m.title
  }
  if (transcript.length < 200) return { status: 400, body: { error: 'Paste the Fathom share link or the transcript itself.' } }
  const deal = body.deal || {}
  const header = [
    `Company: ${deal.company || 'unknown'}`, `Client name: ${deal.name || 'unknown'}`, `Email: ${deal.email || 'unknown'}`,
    `Phone: ${deal.phone || 'unknown'}`, `Website: ${deal.website || 'unknown'}`,
    `Deal type: ${deal.offer === 'trial' ? 'Trial ($997, two weeks)' : 'Retainer'}`, `Onboarding call booked: ${deal.onboarding_call || 'unknown'}`,
    `Closer on the call: ${deal.closer || who.name}`, `Today: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n')
  const model = s.notes_model || 'claude-opus-5'
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16000, system: NOTES_SYSTEM,
      messages: [{ role: 'user', content: `Deal details:\n${header}\n\nCall: ${title || 'sales call'}\n\nTranscript:\n${transcript.slice(0, 180000)}` }] }),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return { status: 502, body: { error: `Claude answered ${r.status}: ${(j.error?.message || '').slice(0, 200)}` } }
  const notes = (j.content || []).map((c: any) => c.text || '').join('').trim()
  const out = { ok: true, notes, title, transcript_chars: transcript.length, model, stop_reason: j.stop_reason, output_tokens: j.usage?.output_tokens, blocks: (j.content || []).map((c: any) => c.type) }
  await log(admin, who, 'call_notes', { company: deal.company, email: deal.email, fathom_url: body.fathom_url }, true, { title, chars: transcript.length, model, stop_reason: j.stop_reason, output_tokens: j.usage?.output_tokens })
  return { status: 200, body: out }
}

// Drop the notes into the client's Slack channel. The bot must be a member;
// channels it made itself are fine, hand-made ones need it added.
async function postNotes(admin: any, who: Caller, body: any) {
  const token = Deno.env.get('SLACK_BOT_TOKEN') || ''
  if (!token) return { status: 500, body: { error: 'SLACK_BOT_TOKEN is not set' } }
  const name = String(body.channel || '').replace(/^#/, '').trim().toLowerCase()
  const text = String(body.text || '').trim()
  if (!name || !text) return { status: 400, body: { error: 'channel and text are required' } }
  let cursor = '', id = ''
  for (let page = 0; page < 10 && !id; page++) {
    const q = new URLSearchParams({ types: 'private_channel,public_channel', exclude_archived: 'true', limit: '1000' })
    if (cursor) q.set('cursor', cursor)
    const r = await fetch(`https://slack.com/api/conversations.list?${q}`, { headers: { Authorization: `Bearer ${token}` } })
    const j: any = await r.json()
    if (!j.ok) return { status: 502, body: { error: `Slack: ${j.error}` } }
    id = (j.channels || []).find((c: any) => c.name === name)?.id || ''
    cursor = j.response_metadata?.next_cursor || ''
    if (!cursor) break
  }
  if (!id) return { status: 404, body: { error: `#${name} was not found among the channels the bot can see. Make the channel, add @Optimus to it, then post again, or copy the notes in by hand.` } }
  const r = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: id, text: `*Post-call notes* (from ${who.name})\n\n${text}`, unfurl_links: false }),
  })
  const j: any = await r.json()
  if (!j.ok) return { status: 502, body: { error: j.error === 'not_in_channel' ? `The bot is not in #${name}. Add @Optimus to the channel and post again, or copy the notes in by hand.` : `Slack: ${j.error}` } }
  const out = { ok: true, channel_id: id, ts: j.ts }
  await log(admin, who, 'post_notes', { company: body.company, email: body.email }, true, { channel: name, ts: j.ts })
  return { status: 200, body: out }
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
      case 'templates': out = await templates(admin); break
      case 'pay_products': out = await payProducts(); break
      case 'stripe_link': out = await stripeLink(admin, who, body); break
      case 'payment_check': out = await paymentCheck(admin, body); break
      case 'ghl_search': out = await ghlSearch(body); break
      case 'deal_status': out = await dealStatus(body); break
      case 'call_notes': out = await callNotes(admin, who, body); break
      case 'post_notes': out = await postNotes(admin, who, body); break
      case 'client_card': out = await clientCard(body); break
      case 'ghl_move': out = await ghlMove(admin, who, body); break
      case 'create_contract': out = await createContract(admin, who, body); break
      case 'send_contract': out = await sendContract(admin, who, body); break
      case 'contract_status': out = await contractStatus(body); break
      case 'whoami': out = { status: 200, body: { name: who.name, email: who.email, isAdmin: who.isAdmin } }; break
      default: out = { status: 400, body: { error: `unknown action "${body.action || ''}"` } }
    }
    // A failed action is logged too, so the error a closer saw can be found
    // afterwards (13 Sep 2026: "it was giving me a PandaDoc API error", and
    // the log held only successes).
    if (out.status >= 400 && ['create_contract', 'send_contract', 'make_channel', 'stripe_link', 'ghl_move', 'call_notes', 'post_notes'].includes(body.action)) {
      await log(admin, who, body.action, body, false, { status: out.status, ...out.body })
    }
    return reply(out.status, out.body)
  } catch (e) {
    const msg = String((e as Error)?.message || e)
    try {
      const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
      await admin.from('closer_hub_actions').insert({ action: 'error', ok: false, result: { error: msg } })
    } catch { /* the audit row must never mask the error */ }
    return reply(500, { error: msg })
  }
})
