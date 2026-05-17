// sync-meta-ad-status — fast status-only refresh for the `ads` table.
//
//   POST /functions/v1/sync-meta-ad-status
//
// Pulls /act_{ACCOUNT_ID}/ads?fields=id,effective_status,status and
// updates every visible ad's status + last_synced_at. Does NOT fetch
// insights or creative metadata, so it's cheap (~1-2s) and safe to run
// on a 15-minute cron. Browser autoSync still calls a JS twin of this
// in metaAdsSync.js for tabs that have the dashboard open; this Edge
// Function covers the no-tab-open case.
//
// Env vars required (Supabase secrets):
//   META_ADS_ACCOUNT_ID    — Meta ad account ID (without the act_ prefix)
//   META_ADS_ACCESS_TOKEN  — Meta Graph API access token
//   SUPABASE_URL           — provided by Supabase runtime
//   SUPABASE_SERVICE_ROLE_KEY — provided by Supabase runtime
//
// Idempotent — UPDATEs by ad_id; ads not yet in the table are skipped
// (the heavier sync-meta-ad-level creates rows; this one just keeps
// status current).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}

const ACCOUNT_ID = Deno.env.get('META_ADS_ACCOUNT_ID')
const ACCESS_TOKEN = Deno.env.get('META_ADS_ACCESS_TOKEN')
const BASE_URL = 'https://graph.facebook.com/v21.0'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (!ACCOUNT_ID || !ACCESS_TOKEN) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Meta Ads credentials missing — set META_ADS_ACCOUNT_ID and META_ADS_ACCESS_TOKEN in Supabase secrets',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
  const startedAt = Date.now()

  try {
    const params = new URLSearchParams({
      access_token: ACCESS_TOKEN,
      fields: 'id,effective_status,status',
      limit: '500',
    })
    let url: string | null = `${BASE_URL}/act_${ACCOUNT_ID}/ads?${params}`
    const records: { ad_id: string; status: string | null; effective_status: string | null }[] = []
    let pages = 0

    while (url) {
      pages++
      const res = await fetch(url)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(`Meta /ads page ${pages} ${res.status}: ${err.error?.message || res.statusText}`)
      }
      const json = await res.json()
      for (const ad of (json.data || [])) {
        if (!ad.id) continue
        records.push({
          ad_id: ad.id,
          status: ad.status || null,
          effective_status: ad.effective_status || null,
        })
      }
      url = json.paging?.next || null
    }

    if (!records.length) {
      return new Response(JSON.stringify({
        success: true, adsSeen: 0, adsUpdated: 0, pages, durationMs: Date.now() - startedAt,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // UPDATE-only, in chunks. Don't upsert — partial records would
    // wipe creative columns on insert. Run row-by-row for accurate
    // count; account-wide totals are usually < 500 ads.
    let updated = 0
    const now = new Date().toISOString()
    for (const r of records) {
      const { error, count } = await supabase
        .from('ads')
        .update(
          { status: r.status, effective_status: r.effective_status, last_synced_at: now },
          { count: 'exact' }
        )
        .eq('ad_id', r.ad_id)
      if (!error && (count || 0) > 0) updated++
    }

    return new Response(JSON.stringify({
      success: true,
      adsSeen: records.length,
      adsUpdated: updated,
      pages,
      durationMs: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('[sync-meta-ad-status]', e)
    return new Response(JSON.stringify({
      success: false,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - startedAt,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
