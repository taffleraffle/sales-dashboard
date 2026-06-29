// match-ad-frames.mjs
// Frame-level ad<->creative matcher. The thumbnail dHash matcher failed because
// Meta picks a different poster frame than our library thumbnail. This pulls
// SEVERAL frames from each video (the ad's asset video + each library final-cut)
// and matches on the closest frame pair — so an aligned frame can be found even
// when the posters differ.
//
//   node scripts/match-ad-frames.mjs [--active] [--threshold=10] [--dry] [--gap=700]
//
// RATE LIMITING (Ben 2026-06-29: don't trip the ad account / fbcdn): ad videos
// are fetched from Meta's CDN one at a time with a minimum gap between requests
// (--gap ms, default 700 => ~1.4 req/s). One ffmpeg call grabs all 6 frames, so
// it's one request per ad video. Library finals (Supabase storage) use a shorter
// gap + small concurrency. Frame hashes are cached so reruns don't refetch.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SALES_URL, KEY = process.env.SALES_KEY;
if (!URL || !KEY) { console.error('Missing SALES_URL / SALES_KEY'); process.exit(1); }
const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const THRESHOLD = Number(flag('threshold', 10));
const FBCDN_GAP = Number(flag('gap', 700));   // ms between Meta CDN requests
const SB_GAP = 250;                            // ms between Supabase requests
const ACTIVE_ONLY = args.includes('--active');
const DRY = args.includes('--dry');
const CACHE_DIR = process.env.CACHE_DIR || '.';
const CACHE_FILE = path.join(CACHE_DIR, 'frame-cache.json');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function rest(p, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { ...opts, headers: { ...H, ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : [];
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dhash(buf) { // 72 bytes (9x8 gray) -> 64-bit
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const l = buf[y*9+x], rr = buf[y*9+x+1];
    bits = (bits << 1n) | (l < rr ? 1n : 0n);
  }
  return bits;
}
function hamming(a, b) { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; }

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
let dirty = 0;
const flush = () => { if (dirty) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); dirty = 0; } };

// Serialised throttle so a whole class of requests never exceeds 1/gap.
let lastSpawn = 0;
async function throttle(gap) { const now = Date.now(); const wait = Math.max(0, lastSpawn + gap - now); lastSpawn = now + wait; if (wait) await sleep(wait); }

function frameHashes(url, gap) {
  if (!url) return Promise.resolve([]);
  if (url in cache) return Promise.resolve(cache[url].map(s => BigInt(s)));
  return new Promise(async (res) => {
    await throttle(gap);
    const ff = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-i', url,
      '-vf','fps=1/2,scale=9:8,format=gray','-frames:v','6','-f','rawvideo','-'], { timeout: 45000 });
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.on('error', () => { cache[url] = []; dirty++; res([]); });
    ff.on('close', () => {
      const b = Buffer.concat(chunks); const out = [];
      for (let i = 0; i + 72 <= b.length; i += 72) out.push(dhash(b.subarray(i, i + 72)));
      cache[url] = out.map(h => h.toString()); dirty++; res(out);
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); if (++done % 10 === 0) { process.stdout.write(`\r  ${done}/${items.length}`); flush(); } }
  }));
  process.stdout.write(`\r  ${items.length}/${items.length}\n`); flush(); return out;
}

const minPairDist = (a, b) => { let m = 999; for (const x of a) for (const y of b) { const d = hamming(x, y); if (d < m) m = d; } return m; };
const fileName = c => c.original_filename || c.custom_name || c.display_name || c.canonical_name || c.name || '(unnamed)';

(async () => {
  console.log(`frame matcher · threshold=${THRESHOLD} fbcdnGap=${FBCDN_GAP}ms activeOnly=${ACTIVE_ONLY} dry=${DRY}`);

  // Library finals (Supabase) — modest concurrency, short gap
  const lib = await rest('lib_creative_library?select=id,name,canonical_name,display_name,custom_name,original_filename,final_cut_url,offer_slug&final_cut_url=not.is.null&limit=5000');
  console.log(`library finals: ${lib.length} — hashing frames…`);
  const libFrames = await pool(lib, 3, c => frameHashes(c.final_cut_url, SB_GAP));
  const libIdx = lib.map((c, i) => ({ c, h: libFrames[i] })).filter(x => x.h.length);
  console.log(`library finals hashed: ${libIdx.length}`);

  // Ad videos (Meta CDN) — STRICT rate limit: concurrency 1, fbcdn gap
  let adQ = 'ads?select=ad_id,ad_name,asset_url,asset_type,effective_status,campaign_name&asset_url=not.is.null&limit=5000';
  if (ACTIVE_ONLY) adQ += '&effective_status=eq.ACTIVE';
  const ads = await rest(adQ);
  console.log(`ads with asset_url: ${ads.length} — hashing frames (rate-limited)…`);
  const adFrames = await pool(ads, 1, a => frameHashes(a.asset_url, FBCDN_GAP));

  const matched = [];
  ads.forEach((a, i) => {
    const ah = adFrames[i]; if (!ah.length) return;
    let best = null, bestD = 999;
    for (const li of libIdx) { const d = minPairDist(ah, li.h); if (d < bestD) { bestD = d; best = li.c; } }
    if (best && bestD <= THRESHOLD) matched.push({ ad_id: a.ad_id, ad_name: a.ad_name, creative_id: best.id, distance: bestD, file_name: fileName(best), campaign: a.campaign_name });
  });

  const fetched = adFrames.filter(f => f.length).length;
  console.log(`\nad videos with frames: ${fetched}/${ads.length}  (rest expired/unfetchable from CDN)`);
  console.log(`matched ${matched.length} ads (distance <= ${THRESHOLD})`);
  console.log('\nsample (ad -> file_name @dist):');
  for (const m of matched.slice(0, 20)) console.log(`  #${m.ad_name} -> ${m.file_name} @${m.distance} [${m.campaign||''}]`);
  fs.writeFileSync(path.join(CACHE_DIR, 'frame-match-report.json'), JSON.stringify(matched, null, 2));

  if (DRY) { console.log('\n[dry] not writing ad_creative_matches'); return; }
  const manual = await rest('ad_creative_matches?select=ad_id&source=eq.manual');
  const manualSet = new Set(manual.map(m => m.ad_id));
  const rows = matched.filter(m => !manualSet.has(m.ad_id)).map(m => ({ ad_id: m.ad_id, creative_id: m.creative_id, distance: m.distance, source: 'auto' }));
  for (let i = 0; i < rows.length; i += 200) {
    await rest('ad_creative_matches?on_conflict=ad_id', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 200)) });
  }
  console.log(`wrote ${rows.length} auto matches (skipped ${manualSet.size} manual).`);
})().catch(e => { flush(); console.error(e); process.exit(1); });
