// One-off diagnostic — what does our `ads` table currently store for
// asset_type='image' rows? Run with: node scripts/audit-image-thumbnails.mjs
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync('.env', 'utf-8').split('\n').reduce((m, line) => {
  const [k, ...v] = line.split('=')
  if (k && v.length) m[k.trim()] = v.join('=').trim()
  return m
}, {})

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const { count: imageCount } = await supabase
  .from('ads').select('*', { count: 'exact', head: true }).eq('asset_type', 'image')

const { count: imageWithAssetUrl } = await supabase
  .from('ads').select('*', { count: 'exact', head: true })
  .eq('asset_type', 'image').not('asset_url', 'is', null)

const { count: imageWithThumb } = await supabase
  .from('ads').select('*', { count: 'exact', head: true })
  .eq('asset_type', 'image').not('thumbnail_url', 'is', null)

const { count: videoCount } = await supabase
  .from('ads').select('*', { count: 'exact', head: true }).eq('asset_type', 'video')

const { count: videoWithAssetUrl } = await supabase
  .from('ads').select('*', { count: 'exact', head: true })
  .eq('asset_type', 'video').not('asset_url', 'is', null)

const { count: unknownCount } = await supabase
  .from('ads').select('*', { count: 'exact', head: true }).eq('asset_type', 'unknown')

const { count: nullTypeCount } = await supabase
  .from('ads').select('*', { count: 'exact', head: true }).is('asset_type', null)

const { count: carouselCount } = await supabase
  .from('ads').select('*', { count: 'exact', head: true }).eq('asset_type', 'carousel')

console.log('\n=== ASSET TYPE BREAKDOWN ===')
console.log(`image    : ${imageCount} total · ${imageWithAssetUrl} with asset_url · ${imageWithThumb} with thumbnail_url`)
console.log(`video    : ${videoCount} total · ${videoWithAssetUrl} with asset_url`)
console.log(`carousel : ${carouselCount}`)
console.log(`unknown  : ${unknownCount}`)
console.log(`null     : ${nullTypeCount}`)

// Sample image rows with NULL asset_url to see what we're missing
const { data: missingImg } = await supabase
  .from('ads').select('ad_id, ad_name, asset_url, thumbnail_url, raw_payload')
  .eq('asset_type', 'image').is('asset_url', null).limit(3)

console.log('\n=== SAMPLE IMAGE ROWS WITH NULL asset_url ===')
for (const r of missingImg || []) {
  console.log(`\nad_id=${r.ad_id}  name=${r.ad_name}`)
  console.log(`  thumbnail_url: ${r.thumbnail_url || 'NULL'}`)
  const creative = r.raw_payload?.creative
  if (creative) {
    console.log(`  creative.image_url:                  ${creative.image_url || 'NULL'}`)
    console.log(`  creative.object_type:                ${creative.object_type || 'NULL'}`)
    console.log(`  oss.photo_data.image_url:            ${creative.object_story_spec?.photo_data?.image_url || 'NULL'}`)
    console.log(`  oss.link_data.picture:               ${creative.object_story_spec?.link_data?.picture || 'NULL'}`)
    console.log(`  oss.link_data.image_url:             ${creative.object_story_spec?.link_data?.image_url || 'NULL'}`)
    console.log(`  oss.link_data.child_attachments[0]:  ${creative.object_story_spec?.link_data?.child_attachments?.[0]?.picture || 'NULL'}`)
  } else {
    console.log(`  raw_payload.creative: NULL (no creative on this ad)`)
  }
}

// Sample image rows that DO have asset_url (verify they render)
const { data: workingImg } = await supabase
  .from('ads').select('ad_id, ad_name, asset_url')
  .eq('asset_type', 'image').not('asset_url', 'is', null).limit(2)

console.log('\n=== SAMPLE IMAGE ROWS THAT DO HAVE asset_url ===')
for (const r of workingImg || []) {
  console.log(`ad_id=${r.ad_id}  name=${r.ad_name}`)
  console.log(`  asset_url: ${r.asset_url?.slice(0, 100)}...`)
}

// The big one — 587 rows with NULL asset_type. Check what they look like.
const { data: nullRows } = await supabase
  .from('ads').select('ad_id, ad_name, asset_url, thumbnail_url, creative_id, raw_payload, last_synced_at')
  .is('asset_type', null).limit(5)

console.log('\n=== SAMPLE NULL asset_type ROWS (the 587) ===')
for (const r of nullRows || []) {
  console.log(`\nad_id=${r.ad_id}  name=${r.ad_name}`)
  console.log(`  creative_id:   ${r.creative_id || 'NULL'}`)
  console.log(`  asset_url:     ${r.asset_url || 'NULL'}`)
  console.log(`  thumbnail_url: ${r.thumbnail_url || 'NULL'}`)
  console.log(`  last_synced:   ${r.last_synced_at || 'NEVER'}`)
  console.log(`  has raw_payload.creative: ${!!r.raw_payload?.creative}`)
}

// Test if a stored Meta CDN URL still resolves (URLs include signed tokens that expire)
console.log('\n=== TESTING URL FRESHNESS ===')
const { data: testRow } = await supabase
  .from('ads').select('ad_id, ad_name, asset_url, last_synced_at')
  .eq('asset_type', 'image').not('asset_url', 'is', null)
  .order('last_synced_at', { ascending: true }).limit(1).single()
if (testRow?.asset_url) {
  console.log(`Testing oldest image: ${testRow.ad_name}  last_synced=${testRow.last_synced_at}`)
  try {
    const res = await fetch(testRow.asset_url, { method: 'HEAD' })
    console.log(`  HTTP ${res.status} ${res.statusText}  content-type=${res.headers.get('content-type')}`)
  } catch (e) { console.log(`  FETCH FAILED: ${e.message}`) }
}
