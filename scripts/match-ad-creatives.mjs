// match-ad-creatives.mjs
// Links each Meta ad to the creative-library clip it was cut from, so the
// Ad Library can show the REAL file name (Meta only gives us "1, 2, 3" + a
// hashed CDN url). No shared key exists between `ads` and `lib_creative_library`,
// so we match on the thumbnail image with a perceptual hash (dHash) computed
// via ffmpeg — no sharp/jimp dependency needed.
//
//   node scripts/match-ad-creatives.mjs [--threshold 12] [--active] [--dry]
//
// Env (export from sentinel/.env): SALES_URL, SALES_KEY (service role).
// Writes auto matches into ad_creative_matches; never clobbers source='manual'.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SALES_URL;
const KEY = process.env.SALES_KEY;
if (!URL || !KEY) { console.error('Missing SALES_URL / SALES_KEY'); process.exit(1); }

const args = process.argv.slice(2);
const THRESHOLD = Number((args.find(a => a.startsWith('--threshold='))||'').split('=')[1]) || 12;
const ACTIVE_ONLY = args.includes('--active');
const DRY = args.includes('--dry');
const CACHE_FILE = path.join(process.env.CACHE_DIR || '.', 'dhash-cache.json');

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function rest(p, opts = {}) {
  const r = await fetch(`${URL}/rest/v1/${p}`, { ...opts, headers: { ...H, ...(opts.headers||{}) } });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

// ---- dHash via ffmpeg (scale to 9x8 gray -> 72 bytes -> 64-bit row-diff hash)
function dhashFromGray(buf) {
  let bits = 0n;
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const l = buf[y * 9 + x], rr = buf[y * 9 + x + 1];
      bits = (bits << 1n) | (l < rr ? 1n : 0n);
    }
  return bits;
}
function hamming(a, b) { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; }

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
let cacheDirty = 0;
function flushCache() { if (cacheDirty) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); cacheDirty = 0; } }

function hashUrl(url) {
  if (!url) return Promise.resolve(null);
  if (url in cache) return Promise.resolve(cache[url] === null ? null : BigInt(cache[url]));
  return new Promise((res) => {
    const ff = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-y','-i', url,
      '-vf','scale=9:8,format=gray','-frames:v','1','-f','rawvideo','-'], { timeout: 30000 });
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.on('error', () => { cache[url] = null; cacheDirty++; res(null); });
    ff.on('close', () => {
      const b = Buffer.concat(chunks);
      if (b.length >= 72) { const h = dhashFromGray(b); cache[url] = h.toString(); cacheDirty++; res(h); }
      else { cache[url] = null; cacheDirty++; res(null); }
    });
  });
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      if (++done % 25 === 0) { process.stdout.write(`\r  hashed ${done}/${items.length}`); flushCache(); }
    }
  }));
  process.stdout.write(`\r  hashed ${items.length}/${items.length}\n`);
  flushCache();
  return out;
}

const fileName = (c) => c.original_filename || c.custom_name || c.display_name || c.canonical_name || c.name || '(unnamed)';

(async () => {
  console.log(`threshold=${THRESHOLD} activeOnly=${ACTIVE_ONLY} dry=${DRY}`);

  // 1. Library clips with any thumbnail
  const lib = await rest('lib_creative_library?select=id,name,canonical_name,display_name,custom_name,original_filename,thumbnail_url,final_cut_thumbnail_url,content_category,status,offer_slug&or=(thumbnail_url.not.is.null,final_cut_thumbnail_url.not.is.null)&limit=5000');
  console.log(`library clips: ${lib.length}`);

  // Each clip can have a raw thumb and an edited (final-cut) thumb — hash both.
  const libThumbs = [];
  for (const c of lib) {
    if (c.thumbnail_url) libThumbs.push({ id: c.id, url: c.thumbnail_url });
    if (c.final_cut_thumbnail_url) libThumbs.push({ id: c.id, url: c.final_cut_thumbnail_url });
  }
  console.log(`library thumbnails to hash: ${libThumbs.length}`);
  const libHashes = await mapPool(libThumbs, 8, t => hashUrl(t.url));
  const libIndex = libThumbs.map((t, i) => ({ id: t.id, h: libHashes[i] })).filter(x => x.h !== null);
  console.log(`library hashes ok: ${libIndex.length}`);

  // 2. Ads with thumbnails (dedup by thumbnail_url — many ads share one creative)
  let adQ = 'ads?select=ad_id,ad_name,thumbnail_url,effective_status,campaign_name&thumbnail_url=not.is.null&limit=5000';
  if (ACTIVE_ONLY) adQ += '&effective_status=eq.ACTIVE';
  const ads = await rest(adQ);
  console.log(`ads: ${ads.length}`);
  const uniqThumbs = [...new Set(ads.map(a => a.thumbnail_url))];
  console.log(`unique ad thumbnails: ${uniqThumbs.length}`);
  const adHashArr = await mapPool(uniqThumbs, 8, u => hashUrl(u));
  const adHashByUrl = new Map(uniqThumbs.map((u, i) => [u, adHashArr[i]]));

  // 3. Match each ad's thumbnail to nearest library clip
  const libById = new Map(lib.map(c => [c.id, c]));
  const matched = [];
  for (const a of ads) {
    const h = adHashByUrl.get(a.thumbnail_url);
    if (h === null || h === undefined) continue;
    let best = null, bestD = 999;
    for (const li of libIndex) {
      const d = hamming(h, li.h);
      if (d < bestD) { bestD = d; best = li.id; }
    }
    if (best !== null && bestD <= THRESHOLD) {
      const c = libById.get(best);
      matched.push({ ad_id: a.ad_id, ad_name: a.ad_name, creative_id: best, distance: bestD,
        file_name: fileName(c), offer_slug: c.offer_slug, campaign: a.campaign_name });
    }
  }
  console.log(`\nmatched ${matched.length}/${ads.length} ads (distance <= ${THRESHOLD})`);
  const dist = {};
  for (const m of matched) { const bucket = m.distance <= 4 ? '0-4' : m.distance <= 8 ? '5-8' : '9-12'; dist[bucket] = (dist[bucket]||0)+1; }
  console.log('distance buckets:', dist);

  // sample for eyeball
  console.log('\nsample matches (ad_name -> file_name @dist):');
  for (const m of matched.slice(0, 15)) console.log(`  #${m.ad_name}  ->  ${m.file_name}  @${m.distance}  [${m.campaign||''}]`);

  fs.writeFileSync(path.join(process.env.CACHE_DIR || '.', 'match-report.json'), JSON.stringify(matched, null, 2));

  if (DRY) { console.log('\n[dry] not writing ad_creative_matches'); return; }

  // 4. Upsert, never clobbering manual links
  const manual = await rest('ad_creative_matches?select=ad_id&source=eq.manual');
  const manualSet = new Set(manual.map(m => m.ad_id));
  const rows = matched.filter(m => !manualSet.has(m.ad_id))
    .map(m => ({ ad_id: m.ad_id, creative_id: m.creative_id, distance: m.distance, source: 'auto' }));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await rest('ad_creative_matches?on_conflict=ad_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk),
    });
    process.stdout.write(`\r  upserted ${Math.min(i+200, rows.length)}/${rows.length}`);
  }
  console.log(`\nwrote ${rows.length} auto matches (skipped ${manualSet.size} manual).`);
})().catch(e => { flushCache(); console.error(e); process.exit(1); });
