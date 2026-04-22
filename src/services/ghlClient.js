// Shared GoHighLevel HTTP client.
//
// Why this exists: GHL enforces a 100 req / 10s per-location rate limit. The
// dashboard used to fire raw `fetch()` calls from five services (pipeline,
// calendar, email flows, meta-ads sync, engagement check, sales intelligence)
// without any coordination. When a user landed on any page while auto-sync was
// running, we could burst 40+ GHL requests in a 2-second window and hit 429.
// The 429 failures were silent — pages would just show "no data available".
//
// Every GHL HTTP call in the app now goes through `ghlFetch`, which:
//   - retries 429s with exponential backoff (1s, 2s, 4s, 8s),
//   - honors the `Retry-After` header when GHL provides one,
//   - leaves non-429 errors (401, 500, etc.) to fail fast,
//   - ultimately returns the final Response so callers can read body/status.

export const BASE_URL = 'https://services.leadconnectorhq.com'

const GHL_API_KEY = import.meta.env.VITE_GHL_API_KEY
const GHL_LOCATION_ID = import.meta.env.VITE_GHL_LOCATION_ID

export const ghlHeaders = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
}

export { GHL_LOCATION_ID }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Fetch a GHL URL with retry-on-429.
 *
 * @param {string} url — full URL (usually `${BASE_URL}/...`).
 * @param {RequestInit & { maxAttempts?: number }} [init] — fetch options. Pass
 *   `maxAttempts` to override the default of 4. Additional headers are merged
 *   on top of the shared `ghlHeaders`.
 * @returns {Promise<Response>} — the final fetch Response. If all retries
 *   exhaust on 429, returns the last 429 response (callers should check `.ok`).
 */
export async function ghlFetch(url, init = {}) {
  const { maxAttempts = 4, headers: extraHeaders, ...rest } = init
  const headers = { ...ghlHeaders, ...(extraHeaders || {}) }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, { ...rest, headers })
    if (res.status !== 429) return res

    const retryAfter = Number(res.headers.get('Retry-After'))
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(8000, 1000 * 2 ** attempt)

    if (attempt === maxAttempts - 1) return res // caller sees .ok === false

    const endpoint = url.split('?')[0].replace(BASE_URL, '')
    console.warn(`[ghlFetch] 429 on ${endpoint} — backing off ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`)
    await sleep(waitMs)
  }
  // Unreachable: the loop either returns on non-429 or on the final attempt.
  throw new Error('ghlFetch: exhausted retries')
}
