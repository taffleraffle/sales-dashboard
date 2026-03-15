import { supabase } from '../lib/supabase'

const API_KEY = import.meta.env.VITE_HYROS_API_KEY
const BASE_URL = 'https://api.hyros.com/v1/api'

/**
 * Sync revenue attribution data from Hyros API into Supabase attribution_daily.
 */
export async function syncHyrosAttribution(days = 30) {
  if (!API_KEY) {
    throw new Error('Hyros API key not configured')
  }

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().split('T')[0]
  const untilStr = new Date().toISOString().split('T')[0]

  // Fetch attribution report from Hyros
  const res = await fetch(`${BASE_URL}/attribution/report`, {
    method: 'POST',
    headers: {
      'API-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      start_date: sinceStr,
      end_date: untilStr,
      group_by: ['campaign', 'date'],
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Hyros API error: ${res.status} ${errText}`)
  }

  const json = await res.json()
  const rows = json.data || json.results || json || []

  if (!Array.isArray(rows)) {
    // If Hyros returns a different structure, try to adapt
    console.warn('Hyros response structure:', Object.keys(json))
    return { synced: 0, skipped: 0, total: 0, note: 'Unexpected response structure' }
  }

  let synced = 0
  let skipped = 0

  for (const row of rows) {
    const record = {
      date: row.date,
      campaign_id: row.campaign_id || row.ad_campaign_id || '',
      campaign_name: row.campaign_name || row.ad_campaign_name || '',
      revenue_attributed: parseFloat(row.revenue || row.total_revenue || 0),
      conversions: parseInt(row.conversions || row.sales || 0),
      roas: row.roas ? parseFloat(row.roas) : null,
      event_tag: row.event_tag || row.tag || 'sale',
    }

    if (!record.date) { skipped++; continue }

    const { error } = await supabase
      .from('attribution_daily')
      .upsert(record, { onConflict: 'date,campaign_id,event_tag' })

    if (error) {
      console.error('Hyros upsert error:', error)
      skipped++
    } else {
      synced++
    }
  }

  return { synced, skipped, total: synced + skipped }
}
