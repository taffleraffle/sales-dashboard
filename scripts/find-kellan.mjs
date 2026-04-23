// Find every reference to "Kellan Lee" in the GHL location.
// Could be a contact name, user name, tag, or referrer custom field.
import { readFileSync } from 'fs'
const envText = readFileSync('.env', 'utf-8')
const env = {}
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/[\r\s]+$/, '').replace(/^["']|["']$/g, '')
}
const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28', Accept: 'application/json' }

// 1. List GHL users
console.log('=== USERS in location ===')
const u = await fetch(`${BASE}/users/?locationId=${LOC}`, { headers })
if (u.ok) {
  const uj = await u.json()
  for (const user of (uj.users || [])) {
    const flag = /kellan|lee/i.test(user.firstName + ' ' + user.lastName) ? ' ⟵ MATCH' : ''
    console.log(`  ${user.id}  ${user.firstName} ${user.lastName}  email=${user.email}${flag}`)
  }
} else {
  console.log('  fetch failed', u.status)
}

// 2. Search contacts by name
console.log('\n=== CONTACTS named "Kellan" (any field) ===')
const c = await fetch(`${BASE}/contacts/search/duplicate?locationId=${LOC}&name=${encodeURIComponent('Kellan Lee')}`, { headers })
console.log('  status', c.status)
const cj = await c.json().catch(() => ({}))
console.log(JSON.stringify(cj, null, 2).slice(0, 800))

// 3. Try POST search (broader)
console.log('\n=== POST /contacts/search "kellan" ===')
const c2 = await fetch(`${BASE}/contacts/search`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ locationId: LOC, query: 'kellan', pageLimit: 20 }),
})
console.log('  status', c2.status)
const c2j = await c2.json().catch(() => ({}))
const hits = c2j.contacts || []
console.log(`  ${hits.length} hits`)
for (const h of hits) {
  console.log(`    ${h.id}  ${h.firstName || ''} ${h.lastName || ''}  email=${h.email || '—'}  phone=${h.phone || '—'}`)
  console.log(`      tags: ${(h.tags || []).join(', ').slice(0, 200)}`)
  console.log(`      source=${h.source || '—'}  customFields=${(h.customFields || []).length}`)
}

// 4. Pull all custom fields and look for "referrer" / "source" / "kellan" in their definitions
console.log('\n=== CUSTOM FIELDS containing "ref" / "source" / "partner" ===')
const cf = await fetch(`${BASE}/locations/${LOC}/customFields`, { headers })
if (cf.ok) {
  const cfj = await cf.json()
  for (const f of (cfj.customFields || [])) {
    if (/ref|source|partner|sent.?by|kellan|affiliate/i.test(f.name || '')) {
      console.log(`  ${f.id}  ${f.name}  type=${f.dataType || f.fieldType}`)
    }
  }
}
