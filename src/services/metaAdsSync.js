import { supabase } from '../lib/supabase'

const ACCOUNT_ID = import.meta.env.VITE_META_ADS_ACCOUNT_ID
const ACCESS_TOKEN = import.meta.env.VITE_META_ADS_ACCESS_TOKEN
const BASE_URL = 'https://graph.facebook.com/v21.0'

/**
 * Fetch ad insights from Meta Ads API and store in Supabase marketing_daily.
 * Pulls campaign-level and adset-level data for the given number of days.
 */
export async function syncMetaAds(days = 30) {
  if (!ACCOUNT_ID || !ACCESS_TOKEN) {
    throw new Error('Meta Ads credentials not configured')
  }

  const since = new Date()
  since.setDate(since.getDate() - days)
  const sinceStr = since.toISOString().split('T')[0]
  const untilStr = new Date().toISOString().split('T')[0]

  // Fetch adset-level insights (includes campaign info)
  const params = new URLSearchParams({
    access_token: ACCESS_TOKEN,
    level: 'adset',
    fields: 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,cost_per_action_type,cpc,ctr',
    time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
    time_increment: 1, // daily breakdown
    limit: '500',
  })

  const url = `${BASE_URL}/act_${ACCOUNT_ID}/insights?${params}`
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Meta Ads API error: ${err.error?.message || res.status}`)
  }

  const json = await res.json()
  const rows = json.data || []

  let synced = 0
  let skipped = 0

  for (const row of rows) {
    // Extract lead count from actions array
    const leadAction = (row.actions || []).find(a => a.action_type === 'lead' || a.action_type === 'offsite_conversion.fb_pixel_lead')
    const leads = leadAction ? parseInt(leadAction.value) : 0

    // Extract CPL from cost_per_action_type
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
      leads: leads,
      cpc: row.cpc ? parseFloat(row.cpc) : null,
      cpl: cpl,
      ctr: row.ctr ? parseFloat(row.ctr) : null,
    }

    // Upsert on unique constraint (date, campaign_id, adset_id)
    const { error } = await supabase
      .from('marketing_daily')
      .upsert(record, { onConflict: 'date,campaign_id,adset_id' })

    if (error) {
      console.error('Meta ads upsert error:', error)
      skipped++
    } else {
      synced++
    }
  }

  // Handle pagination if there are more results
  let nextUrl = json.paging?.next
  while (nextUrl) {
    const nextRes = await fetch(nextUrl)
    if (!nextRes.ok) break
    const nextJson = await nextRes.json()
    const nextRows = nextJson.data || []

    for (const row of nextRows) {
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
        leads: leads,
        cpc: row.cpc ? parseFloat(row.cpc) : null,
        cpl: cpl,
        ctr: row.ctr ? parseFloat(row.ctr) : null,
      }

      const { error } = await supabase
        .from('marketing_daily')
        .upsert(record, { onConflict: 'date,campaign_id,adset_id' })

      if (error) skipped++
      else synced++
    }

    nextUrl = nextJson.paging?.next
  }

  return { synced, skipped, total: synced + skipped }
}
