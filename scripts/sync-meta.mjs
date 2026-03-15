import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  'https://kjfaqhmllagbxjdxlopm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
)

const ACCOUNT_ID = '2823980217854527'
const ACCESS_TOKEN = 'EAAK318GZCneMBQ7GxoqVHTXUnUUJNZBMkq5vlk7MdNhIVkloDSKMUTxlmn5sjQ0BujJlk7tX1zmMbUvjHui5hX3ACpDjqmTeaSkVdQvTYWz2O2FyIanZB37UfvaZCooHZAHUOxdwWpCSEhaM8r4JFvZAg1J13cocZBp8OKRXYdeUJvKhwnkcwmderYwfZC4NWEeKMHm5LrePmwx0iIkZByX3niDJv4wtIj3UCBOSOFpd9'

const since = new Date()
since.setDate(since.getDate() - 30)
const sinceStr = since.toISOString().split('T')[0]
const untilStr = new Date().toISOString().split('T')[0]

const params = new URLSearchParams({
  access_token: ACCESS_TOKEN,
  level: 'adset',
  fields: 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,cost_per_action_type,cpc,ctr',
  time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
  time_increment: 1,
  limit: '500',
})

async function processRows(rows) {
  let synced = 0
  for (const row of rows) {
    const leadAction = (row.actions || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
    const leads = leadAction ? parseInt(leadAction.value) : 0
    const cplAction = (row.cost_per_action_type || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
    const cpl = cplAction ? parseFloat(cplAction.value) : (leads > 0 ? parseFloat(row.spend) / leads : null)

    const record = {
      date: row.date_start,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      adset_id: row.adset_id,
      adset_name: row.adset_name,
      spend: parseFloat(row.spend || 0),
      impressions: parseInt(row.impressions || 0),
      clicks: parseInt(row.clicks || 0),
      leads,
      cpc: row.cpc ? parseFloat(row.cpc) : null,
      cpl,
      ctr: row.ctr ? parseFloat(row.ctr) : null,
    }

    const { error } = await sb.from('marketing_daily').upsert(record, { onConflict: 'date,campaign_id,adset_id' })
    if (error) console.error('Upsert error:', error.message)
    else synced++
  }
  return synced
}

const res = await fetch(`https://graph.facebook.com/v21.0/act_${ACCOUNT_ID}/insights?${params}`)
const json = await res.json()
if (json.error) { console.error('API error:', json.error.message); process.exit(1) }

let total = await processRows(json.data || [])
console.log(`Page 1: ${json.data?.length || 0} rows`)

let nextUrl = json.paging?.next
while (nextUrl) {
  const nextRes = await fetch(nextUrl)
  const nextJson = await nextRes.json()
  total += await processRows(nextJson.data || [])
  console.log(`Next page: ${nextJson.data?.length || 0} rows`)
  nextUrl = nextJson.paging?.next
}

console.log(`Done! Synced ${total} marketing records`)
