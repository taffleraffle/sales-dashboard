// Live NZD->USD exchange rate. Meta spend is stored in NZD; the dashboard shows
// USD, and Ben wants the rate to track reality instead of a hardcoded 0.56.
//
// Sources are free, no-key, CORS-enabled and update daily (good enough for spend
// reporting — intraday FX would need a paid key). Result is cached in
// localStorage for 12h so we don't refetch on every mount, with graceful
// fallback: fresh cache -> live fetch -> stale cache -> env/static default.
const FALLBACK = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')
const CACHE_KEY = 'fx.nzdusd.v1'
const TTL = 12 * 60 * 60 * 1000

const SOURCES = [
  async () => {
    const r = await fetch('https://open.er-api.com/v6/latest/NZD')
    if (!r.ok) throw new Error('er-api ' + r.status)
    const j = await r.json()
    const rate = j?.rates?.USD
    if (!rate) throw new Error('er-api no USD')
    return rate
  },
  async () => {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?base=NZD&symbols=USD')
    if (!r.ok) throw new Error('frankfurter ' + r.status)
    const j = await r.json()
    const rate = j?.rates?.USD
    if (!rate) throw new Error('frankfurter no USD')
    return rate
  },
]

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw)
    return c && c.rate ? c : null
  } catch { return null }
}

// Returns { rate, ts, live } — live=true when the rate came from a successful
// fetch (or a still-fresh cache of one), false when we fell back to a stale
// cache or the static default.
export async function getNzdToUsd() {
  const cached = readCache()
  if (cached && Date.now() - cached.ts < TTL) return { ...cached, live: true }

  for (const fetchRate of SOURCES) {
    try {
      const rate = await fetchRate()
      const ts = Date.now()
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rate, ts })) } catch { /* private mode */ }
      return { rate, ts, live: true }
    } catch { /* try next source */ }
  }

  if (cached) return { ...cached, live: false }   // stale beats nothing
  return { rate: FALLBACK, ts: null, live: false }
}
