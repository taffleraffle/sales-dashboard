// One-off lookup: do these typeform leads exist in GHL, and do they have appointments?
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
    })
)
const GHL_API_KEY = env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = env.VITE_GHL_LOCATION_ID
const BASE_URL = 'https://services.leadconnectorhq.com'

const headers = {
  Authorization: `Bearer ${GHL_API_KEY}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
}

const leads = [
  { name: 'Luigui',        email: 'realmoldsolution@gmail.com',         phone: '+14076161860', submitted: '2026-04-25 07:29' },
  { name: 'Carlos Ruiz',   email: 'cruiz@fungienvironmentalseevices.com', phone: '+14695521578', submitted: '2026-04-24 10:08' },
  { name: 'Zalton',        email: 'otmrei@gmail.com',                   phone: '+19298778700', submitted: '2026-04-24 00:36' },
  { name: 'Semso Aliman',  email: 'esmbpropertysolutions@gmail.com',    phone: null,           submitted: '2026-04-23 01:55' },
  { name: 'Richard',       email: 'rich@reactrestores.net',             phone: '+16108583469', submitted: '2026-04-21 10:28' },
  { name: 'Angelo',        email: 'angelo@preferredchoicerestorations.com', phone: null,       submitted: '2026-04-20 22:20' },
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function ghlFetch(url, init = {}, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } })
    if (res.status !== 429) return res
    const retryAfter = Number(res.headers.get('Retry-After'))
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(15000, 1500 * 2 ** attempt)
    if (attempt === maxAttempts - 1) return res
    console.log(`     [429] backing off ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`)
    await sleep(wait)
  }
}

async function searchByEmail(email) {
  const body = {
    locationId: GHL_LOCATION_ID,
    pageLimit: 5,
    filters: [{ field: 'email', operator: 'eq', value: email }],
  }
  const res = await ghlFetch(`${BASE_URL}/contacts/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() }
  const json = await res.json()
  return { ok: true, contacts: json.contacts || [] }
}

async function searchByPhone(phone) {
  const body = {
    locationId: GHL_LOCATION_ID,
    pageLimit: 5,
    filters: [{ field: 'phone', operator: 'eq', value: phone }],
  }
  const res = await ghlFetch(`${BASE_URL}/contacts/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() }
  const json = await res.json()
  return { ok: true, contacts: json.contacts || [] }
}

async function getAppointments(contactId) {
  const res = await ghlFetch(`${BASE_URL}/contacts/${contactId}/appointments`)
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() }
  const json = await res.json()
  return { ok: true, events: json.events || [] }
}

async function main() {
  console.log(`\n=== GHL Lead Lookup (${leads.length} leads) ===\n`)
  for (const lead of leads) {
    console.log(`\n--- ${lead.name} (${lead.email || lead.phone}) — submitted ${lead.submitted} ---`)

    let contacts = []
    if (lead.email) {
      const r = await searchByEmail(lead.email)
      if (!r.ok) {
        console.log(`  email search failed: ${r.status} ${r.body?.slice(0, 200)}`)
      } else {
        contacts = r.contacts
        console.log(`  email match: ${contacts.length} contact(s)`)
      }
    }

    if (contacts.length === 0 && lead.phone) {
      const r = await searchByPhone(lead.phone)
      if (!r.ok) {
        console.log(`  phone search failed: ${r.status} ${r.body?.slice(0, 200)}`)
      } else {
        contacts = r.contacts
        console.log(`  phone match: ${contacts.length} contact(s)`)
      }
    }

    if (contacts.length === 0) {
      console.log(`  ❌ NOT IN GHL`)
      continue
    }

    for (const c of contacts) {
      console.log(`  ✅ contact: ${c.id}`)
      console.log(`     name:    ${c.firstName || ''} ${c.lastName || ''}`.trim() + ` / ${c.contactName || ''}`)
      console.log(`     email:   ${c.email}`)
      console.log(`     phone:   ${c.phone}`)
      console.log(`     created: ${c.dateAdded || c.createdAt}`)
      console.log(`     tags:    ${(c.tags || []).join(', ') || '(none)'}`)
      if (c.assignedTo) console.log(`     assigned:${c.assignedTo}`)

      const apt = await getAppointments(c.id)
      if (!apt.ok) {
        console.log(`     appts:   error fetching`)
      } else if (apt.events.length === 0) {
        console.log(`     appts:   ❌ NO APPOINTMENTS`)
      } else {
        console.log(`     appts:   ✅ ${apt.events.length} appointment(s):`)
        for (const e of apt.events) {
          console.log(`       - ${e.startTime} → ${e.endTime} | cal:${e.calendarId} | status:${e.appointmentStatus} | title:${e.title}`)
        }
      }

      await sleep(1500)
    }
    await sleep(1500)
  }
  console.log('\n=== done ===')
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
