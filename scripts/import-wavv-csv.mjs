/**
 * Import WAVV CSV call history into wavv_calls table.
 * Usage: node scripts/import-wavv-csv.mjs
 *
 * Reads CSV files from Downloads folder, maps to wavv_calls schema,
 * and upserts into Supabase (deduplicates on call_id).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Read .env file
const envContent = readFileSync(resolve(__dirname, '../.env'), 'utf-8')
const env = {}
envContent.replace(/\r/g, '').split('\n').forEach(line => {
  const match = line.match(/^([^#=]+)=(.*)$/)
  if (match) env[match[1].trim()] = match[2].trim()
})

const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// CSV files to import — setter name used to look up wavv_user_id afterwards
const FILES = [
  {
    path: resolve(process.env.USERPROFILE || process.env.HOME, 'Downloads/Outbound Call History 2026-03-15  (LeAndre P).csv'),
    setterName: 'LeAndre',
  },
  {
    path: resolve(process.env.USERPROFILE || process.env.HOME, 'Downloads/Outbound Call History 2026-03-15  (Josh Stolz).csv'),
    setterName: 'Josh',
  },
]

function parseCSV(content) {
  // Full RFC 4180 CSV parser — handles multi-line quoted fields (transcripts)
  const records = []
  let current = ''
  let inQuotes = false
  const fields = []
  let headers = null

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < content.length && content[i + 1] === '\n') i++
        fields.push(current)
        current = ''
        if (!headers) {
          headers = fields.map(h => h.trim())
        } else if (fields.length >= headers.length) {
          const row = {}
          headers.forEach((h, idx) => { row[h] = fields[idx] || '' })
          records.push(row)
        }
        fields.length = 0
      } else {
        current += ch
      }
    }
  }
  // Handle last record if file doesn't end with newline
  if (fields.length > 0 || current) {
    fields.push(current)
    if (headers && fields.length >= headers.length) {
      const row = {}
      headers.forEach((h, idx) => { row[h] = fields[idx] || '' })
      records.push(row)
    }
  }

  return records
}

function normalizePhone(phone) {
  if (!phone) return null
  return phone.replace(/[^0-9+]/g, '')
}

async function importFile(filePath, setterName) {
  console.log(`\nReading ${filePath}...`)
  const content = readFileSync(filePath, 'utf-8')
  const rows = parseCSV(content)
  console.log(`  Parsed ${rows.length} rows for ${setterName}`)

  // Look up setter's team_members record to get their ID
  const { data: member } = await supabase
    .from('team_members')
    .select('id, wavv_user_id')
    .ilike('name', `%${setterName}%`)
    .single()

  const setterId = member?.id || null
  console.log(`  Setter ID: ${setterId || 'NOT FOUND'}`)

  // Map CSV rows to wavv_calls records
  const records = rows
    .filter(r => r['Call ID'] && r['Timestamp'])
    .map(r => ({
      call_id: r['Call ID'],
      contact_name: r['Contact Name'] || null,
      phone_number: normalizePhone(r['Number']),
      started_at: r['Timestamp'],
      call_duration: parseInt(r['Duration']) || 0,
      user_id: member?.wavv_user_id || setterName.toLowerCase(),
      team_id: null,
      setter_id: setterId,
    }))

  console.log(`  Mapped ${records.length} valid records`)

  // Batch upsert in chunks of 500
  const BATCH_SIZE = 500
  let inserted = 0
  let errors = 0

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('wavv_calls')
      .upsert(batch, { onConflict: 'call_id' })

    if (error) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, error.message)
      errors++
    } else {
      inserted += batch.length
      process.stdout.write(`  Imported ${inserted}/${records.length}\r`)
    }
  }

  console.log(`  Done: ${inserted} imported, ${errors} batch errors`)
  return { setterName, total: records.length, inserted, errors }
}

async function main() {
  console.log('=== WAVV CSV Import ===')

  // First check what's currently in wavv_calls
  const { count } = await supabase
    .from('wavv_calls')
    .select('*', { count: 'exact', head: true })
  console.log(`Current wavv_calls count: ${count}`)

  const results = []
  for (const file of FILES) {
    try {
      const result = await importFile(file.path, file.setterName)
      results.push(result)
    } catch (err) {
      console.error(`Failed to import ${file.path}:`, err.message)
    }
  }

  // Final count
  const { count: newCount } = await supabase
    .from('wavv_calls')
    .select('*', { count: 'exact', head: true })
  console.log(`\n=== Summary ===`)
  console.log(`Before: ${count} rows`)
  console.log(`After:  ${newCount} rows`)
  results.forEach(r => console.log(`  ${r.setterName}: ${r.inserted} calls imported`))

  // Show date range of imported data
  const { data: dateRange } = await supabase
    .from('wavv_calls')
    .select('started_at')
    .order('started_at', { ascending: true })
    .limit(1)
  const { data: dateRangeEnd } = await supabase
    .from('wavv_calls')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)

  if (dateRange?.[0] && dateRangeEnd?.[0]) {
    console.log(`Date range: ${dateRange[0].started_at.split('T')[0]} → ${dateRangeEnd[0].started_at.split('T')[0]}`)
  }
}

main().catch(console.error)
