// Round 2: try fuzzy spellings, tags, Meta campaigns/adsets/ads.
import { readFileSync } from 'fs'
const envText = readFileSync('.env', 'utf-8')
const env = {}
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/[\r\s]+$/, '').replace(/^["']|["']$/g, '')
}
const KEY = env.VITE_GHL_API_KEY
const LOC = env.VITE_GHL_LOCATION_ID
const META_TOKEN = env.VITE_META_ADS_ACCESS_TOKEN
const META_ACCT = env.VITE_META_ADS_ACCOUNT_ID
const BASE = 'https://services.leadconnectorhq.com'
const headers = { Authorization: `Bearer ${KEY}`, Version: '2021-07-28', Accept: 'application/json' }

// 1. Try multiple spellings as POST search
const variants = ['kellan', 'kellen', 'killian', 'kellan lee', 'kellen lee', 'kellanlee', 'lee']
console.log('=== GHL contact search variants ===')
for (const q of variants) {
  const r = await fetch(`${BASE}/contacts/search`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId: LOC, query: q, pageLimit: 5 }),
  })
  const j = await r.json().catch(() => ({}))
  const hits = j.contacts || []
  console.log(`  "${q}": ${hits.length} hits${hits.length ? '  →  ' + hits.slice(0, 3).map(h => `${h.firstName || ''} ${h.lastName || ''} (${h.email || h.phone || h.id})`).join(' | ') : ''}`)
}

// 2. List all unique tags by sampling 200 contacts
console.log('\n=== Sampling 200 contacts for tags containing "kel|lee|partner|referr" ===')
let after = null, afterId = null, page = 0
const tagCounts = {}
while (page < 2) {
  const params = new URLSearchParams({ locationId: LOC, limit: '100' })
  if (afterId) { params.set('startAfterId', afterId); params.set('startAfter', String(after)) }
  const res = await fetch(`${BASE}/contacts/?${params}`, { headers })
  if (!res.ok) break
  const j = await res.json()
  for (const c of (j.contacts || [])) {
    for (const t of (c.tags || [])) {
      if (/kel|lee|partner|referr|affiliat|broker|youtub|creator/i.test(t)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1
      }
    }
  }
  if (!j.meta?.startAfterId) break
  afterId = j.meta.startAfterId
  after = j.meta.startAfter
  page++
}
const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])
if (!sorted.length) console.log('  (no matching tags in first 200 contacts)')
for (const [t, n] of sorted) console.log(`  ${t}: ${n}`)

// 3. Meta Ads — search campaigns + adsets + ads for "kellan"
if (META_TOKEN && META_ACCT) {
  console.log('\n=== META campaigns/adsets/ads containing "kellan|lee" ===')
  for (const level of ['campaigns', 'adsets', 'ads']) {
    const url = `https://graph.facebook.com/v21.0/act_${META_ACCT}/${level}?fields=id,name,status&limit=200&access_token=${META_TOKEN}`
    const r = await fetch(url)
    const j = await r.json().catch(() => ({}))
    const hits = (j.data || []).filter(x => /kellan|kellen|kellanlee/i.test(x.name || ''))
    console.log(`  ${level}: ${hits.length} hits (of ${(j.data || []).length} fetched)`)
    for (const h of hits) console.log(`    ${h.id}  ${h.name}  (${h.status})`)
    // Bonus: also list any ad with "lee" in the name
    if (level === 'ads') {
      const leeHits = (j.data || []).filter(x => /\blee\b/i.test(x.name || ''))
      if (leeHits.length) {
        console.log('  Ads with " lee ":')
        for (const h of leeHits.slice(0, 10)) console.log(`    ${h.id}  ${h.name}`)
      }
    }
  }
} else {
  console.log('\n  (no Meta token in .env, skipping)')
}
