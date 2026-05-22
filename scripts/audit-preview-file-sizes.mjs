// audit-preview-file-sizes.mjs
//
// Probes every lib_creative_library row whose preview_url points at the
// /previews/ path and compares the DB's size_mb against the actual bytes
// stored. Spits out a table so we can see which clips are usable, which
// are truncated to placeholder-size, and which are missing entirely.
//
// Findings drive what we do next: for stuck rows the "preview" file is
// often a 1-2 MB placeholder (NOT a 720p transcode), meaning the
// original ingest pipeline kept only a partial header. Those clips
// cannot be played or downloaded at any usable quality without a fresh
// upload from source.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1) }

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

async function headSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' })
    if (!r.ok) return { ok: false, status: r.status, bytes: 0 }
    return { ok: true, status: r.status, bytes: Number(r.headers.get('content-length') || 0) }
  } catch (e) { return { ok: false, status: 'ERR', bytes: 0, err: e.message } }
}

async function main() {
  const { data: rows, error } = await supabase
    .from('lib_creative_library')
    .select('id, canonical_name, name, type, size_mb, duration_seconds, preview_url, drive_url, final_cut_url')
    .like('preview_url', '%creative-uploads/previews/%')
    .eq('exclude_from_library', false)
    .order('added_at', { ascending: false })
  if (error) { console.error(error); process.exit(1) }
  console.log(`Probing ${rows.length} preview/ rows…`)

  const results = []
  for (const r of rows) {
    const h = await headSize(r.preview_url)
    const actualMB = h.bytes / 1024 / 1024
    const declaredMB = Number(r.size_mb || 0)
    const ratio = declaredMB > 0 ? actualMB / declaredMB : null
    results.push({
      id: r.id,
      name: r.canonical_name || r.name,
      type: r.type,
      declared_mb: declaredMB,
      actual_mb: actualMB,
      ratio,
      duration: r.duration_seconds,
      mbps: r.duration_seconds > 0 ? (h.bytes * 8 / r.duration_seconds / 1_000_000) : null,
      has_drive: !!r.drive_url,
      has_final_cut: !!r.final_cut_url,
      status: h.status,
    })
  }

  // Classify
  const broken    = results.filter((r) => r.actual_mb < 3)                  // truncated placeholders
  const subPar    = results.filter((r) => r.actual_mb >= 3 && r.mbps < 4)   // real but low bitrate
  const ok        = results.filter((r) => r.mbps >= 4)                     // decent quality
  const noProbe   = results.filter((r) => r.status !== 200)

  console.log(`\n--- AUDIT SUMMARY ---`)
  console.log(`Total rows probed:                   ${results.length}`)
  console.log(`Broken/placeholder (<3 MB actual):   ${broken.length}`)
  console.log(`Sub-par quality (<4 Mbps real):      ${subPar.length}`)
  console.log(`Decent quality (>=4 Mbps):           ${ok.length}`)
  console.log(`HEAD failed (404 / other):           ${noProbe.length}`)

  console.log(`\n--- BROKEN / PLACEHOLDER FILES (top 15) ---`)
  console.log(`These rows display + download as garbage. Need re-upload from source.`)
  broken.sort((a, b) => a.actual_mb - b.actual_mb).slice(0, 15).forEach((r) => {
    console.log(`  ${r.actual_mb.toFixed(2)} MB (DB says ${r.declared_mb} MB) · ${r.duration ?? '?'}s · ${r.type} · ${r.name}${r.has_drive ? ' · HAS drive_url' : ''}`)
  })

  console.log(`\n--- SUB-PAR QUALITY (real video, but <4 Mbps) ---`)
  subPar.sort((a, b) => a.mbps - b.mbps).slice(0, 10).forEach((r) => {
    console.log(`  ${r.mbps?.toFixed(1)} Mbps · ${r.actual_mb.toFixed(1)} MB · ${r.duration}s · ${r.name}`)
  })

  console.log(`\n--- DECENT QUALITY (>=4 Mbps - usable) ---`)
  ok.sort((a, b) => b.mbps - a.mbps).slice(0, 10).forEach((r) => {
    console.log(`  ${r.mbps?.toFixed(1)} Mbps · ${r.actual_mb.toFixed(1)} MB · ${r.duration}s · ${r.name}`)
  })

  // Write a CSV report for Ben to triage from
  const csv = ['id,name,type,declared_mb,actual_mb,duration_sec,mbps,has_drive,has_final_cut,classification']
  for (const r of results) {
    const cls = r.status !== 200 ? 'HTTP_' + r.status
              : r.actual_mb < 3 ? 'BROKEN_PLACEHOLDER'
              : r.mbps < 4 ? 'SUB_PAR'
              : 'OK'
    csv.push([r.id, `"${r.name}"`, r.type, r.declared_mb, r.actual_mb.toFixed(2), r.duration ?? '', r.mbps?.toFixed(1) ?? '', r.has_drive, r.has_final_cut, cls].join(','))
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync('preview-audit.csv', csv.join('\n'))
  console.log(`\nFull report written to preview-audit.csv (${results.length} rows)`)

  // --- Write flags back to DB (skip in DRY_RUN=1) ---
  if (process.env.DRY_RUN === '1') {
    console.log('\nDRY_RUN=1 → not writing is_low_quality flags. Re-run without DRY_RUN to apply.')
    return
  }
  console.log('\nWriting is_low_quality flags to DB…')
  const now = new Date().toISOString()
  let flagged = 0
  let cleared = 0
  let sizeFixed = 0
  for (const r of results) {
    const isLow = r.actual_mb < 3 || (r.mbps != null && r.mbps < 4)
    const reason = r.actual_mb < 3 ? 'placeholder'
                 : r.mbps != null && r.mbps < 4 ? 'subpar'
                 : null
    const patch = {
      is_low_quality: isLow,
      low_quality_reason: isLow ? reason : null,
      low_quality_actual_mb: Number(r.actual_mb.toFixed(2)),
      low_quality_detected_at: now,
    }
    // Also correct the lying size_mb if it's off by >2x. Keep the original
    // size in low_quality_actual_mb in case we need to compare later.
    if (r.declared_mb > 0 && r.actual_mb > 0 && Math.abs(r.declared_mb - r.actual_mb) / r.declared_mb > 0.5) {
      patch.size_mb = Number(r.actual_mb.toFixed(1))
      sizeFixed++
    }
    const { error: upErr } = await supabase.from('lib_creative_library').update(patch).eq('id', r.id)
    if (upErr) { console.error(`Update failed for ${r.id}: ${upErr.message}`); continue }
    if (isLow) flagged++; else cleared++
  }
  console.log(`Flagged is_low_quality=TRUE: ${flagged}`)
  console.log(`Flagged is_low_quality=FALSE (cleared): ${cleared}`)
  console.log(`Corrected lying size_mb on ${sizeFixed} rows`)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
