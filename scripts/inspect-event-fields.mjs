// Look at the FULL event payload + contact custom fields for a known
// qualified booking and a known DQ booking. Goal: find any field that
// distinguishes them automatically without needing a new API connection.

import { readFileSync } from 'node:fs'
const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${env.VITE_GHL_API_KEY}`, Version: '2021-07-28' }

// One known qualified (T5Zif), one known DQ (gohF), one cEy DQ-routed
const samples = [
  ['QUALIFIED', 'mikehagan02@gmail.com'], // Mike — $75-100k, IMPORTANT button
  ['DQ',        'thomas.walker@myvoda.com'], // Thomas — $0-30k, Great! button (gohF)
  ['DQ-cEy',    'vladyslavkyz@gmail.com'], // Vlad — $0-30k, Great! button (lands cEy)
]

for (const [label, email] of samples) {
  console.log(`\n=== ${label} :: ${email} ===\n`)
  const cr = await fetch(`${BASE}/contacts/search/duplicate?locationId=${env.VITE_GHL_LOCATION_ID}&email=${encodeURIComponent(email)}`, { headers })
  if (!cr.ok) { console.log(`HTTP ${cr.status}`); continue }
  const cj = await cr.json()
  if (!cj.contact) { console.log('NO CONTACT'); continue }

  // Full contact record
  const detail = await fetch(`${BASE}/contacts/${cj.contact.id}`, { headers })
  const dj = await detail.json()
  const contact = dj.contact || dj
  console.log(`Contact tags: ${JSON.stringify(contact.tags || [])}`)
  console.log(`Contact source: ${contact.source}`)
  console.log(`Custom fields: ${JSON.stringify(contact.customFields || [], null, 2)}`)

  // First appointment
  const ar = await fetch(`${BASE}/contacts/${cj.contact.id}/appointments`, { headers })
  const aj = await ar.json()
  const evt = (aj.events || [])[0]
  if (!evt) { console.log('NO APPOINTMENTS'); continue }
  console.log(`\nFirst appointment full payload:`)
  console.log(JSON.stringify(evt, null, 2))
}
