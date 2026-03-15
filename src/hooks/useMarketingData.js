import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'
import { syncMetaAds } from '../services/metaAdsSync'

export function useMarketingData(days = 30) {
  const [data, setData] = useState({ campaigns: [], totals: {}, daily: [] })
  const [loading, setLoading] = useState(true)
  const [syncStatus, setSyncStatus] = useState(null)

  useEffect(() => {
    async function load() {
      const since = sinceDate(days)

      // Fetch marketing_daily
      const { data: marketing } = await supabase
        .from('marketing_daily')
        .select('*')
        .gte('date', since)
        .order('date', { ascending: false })

      // Fetch attribution_daily
      const { data: attribution } = await supabase
        .from('attribution_daily')
        .select('*')
        .gte('date', since)

      let rows = marketing || []
      const attRows = attribution || []

      // Auto-sync from Meta Ads if table is empty
      if (rows.length === 0) {
        setSyncStatus('Syncing Meta Ads...')
        try {
          await syncMetaAds(days)
          const { data: fresh } = await supabase
            .from('marketing_daily')
            .select('*')
            .gte('date', since)
            .order('date', { ascending: false })
          rows = fresh || []
        } catch (err) {
          console.warn('Auto Meta sync failed:', err.message)
        }
        setSyncStatus(null)
      }

      // Totals
      const totalSpend = rows.reduce((s, r) => s + parseFloat(r.spend || 0), 0)
      const totalClicks = rows.reduce((s, r) => s + (r.clicks || 0), 0)
      const totalImpressions = rows.reduce((s, r) => s + (r.impressions || 0), 0)
      const totalLeads = rows.reduce((s, r) => s + (r.leads || 0), 0)
      const totalRevenue = attRows.reduce((s, r) => s + parseFloat(r.revenue_attributed || 0), 0)
      const totalConversions = attRows.reduce((s, r) => s + (r.conversions || 0), 0)

      const cpl = totalLeads > 0 ? totalSpend / totalLeads : 0
      const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0
      const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0
      const roas = totalSpend > 0 ? totalRevenue / totalSpend : 0
      const cpa = totalConversions > 0 ? totalSpend / totalConversions : 0

      // Per-campaign aggregation
      const campaignMap = {}
      for (const r of rows) {
        const key = r.campaign_id || 'unknown'
        if (!campaignMap[key]) {
          campaignMap[key] = { campaign_id: key, campaign_name: r.campaign_name || 'Unknown', spend: 0, clicks: 0, impressions: 0, leads: 0 }
        }
        campaignMap[key].spend += parseFloat(r.spend || 0)
        campaignMap[key].clicks += (r.clicks || 0)
        campaignMap[key].impressions += (r.impressions || 0)
        campaignMap[key].leads += (r.leads || 0)
      }

      // Attach attribution revenue to campaigns
      for (const a of attRows) {
        const key = a.campaign_id || 'unknown'
        if (campaignMap[key]) {
          campaignMap[key].revenue = (campaignMap[key].revenue || 0) + parseFloat(a.revenue_attributed || 0)
          campaignMap[key].conversions = (campaignMap[key].conversions || 0) + (a.conversions || 0)
        }
      }

      const campaigns = Object.values(campaignMap).map(c => ({
        ...c,
        cpl: c.leads > 0 ? c.spend / c.leads : 0,
        cpc: c.clicks > 0 ? c.spend / c.clicks : 0,
        roas: c.spend > 0 ? (c.revenue || 0) / c.spend : 0,
      })).sort((a, b) => b.spend - a.spend)

      // Daily aggregation for trend
      const dailyMap = {}
      for (const r of rows) {
        if (!dailyMap[r.date]) dailyMap[r.date] = { date: r.date, spend: 0, leads: 0, clicks: 0 }
        dailyMap[r.date].spend += parseFloat(r.spend || 0)
        dailyMap[r.date].leads += (r.leads || 0)
        dailyMap[r.date].clicks += (r.clicks || 0)
      }
      const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date))

      setData({
        campaigns,
        totals: { totalSpend, totalClicks, totalImpressions, totalLeads, totalRevenue, totalConversions, cpl, cpc, ctr, roas, cpa },
        daily,
      })
      setLoading(false)
    }
    load()
  }, [days])

  return { data, loading, syncStatus }
}
