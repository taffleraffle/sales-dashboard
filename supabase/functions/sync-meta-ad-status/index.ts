// sync-meta-ad-status — fast status-only refresh for the `ads` table.
//
//   POST /functions/v1/sync-meta-ad-status
//
// Pulls /act_{ACCOUNT_ID}/ads?fields=id,effective_status,status and
// updates every ad's status. UPDATE-only (no insert), batched so 500
// ads finish in 1-2s instead of 60+.

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
      error: 'Set META_ADS_ACCOUNT_ID and META_ADS_ACCESS_TOKEN secrets',
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

    // Filter to ads that already exist in the table so upsert only does
    // UPDATEs — never INSERTs an incomplete row that would NULL out
    // ad_name / creative_id / campaign_name etc.
    const adIds = records.map(r => r.ad_id)
    const existing = new Set<string>()
    // Chunk the .in() filter because PostgREST URLs cap around 1000 ids.
    const CHUNK_LOOKUP = 500
    for (let i = 0; i < adIds.length; i += CHUNK_LOOKUP) {
      const slice = adIds.slice(i, i + CHUNK_LOOKUP)
      const { data, error } = await supabase
        .from('ads')
        .select('ad_id')
        .in('ad_id', slice)
      if (error) throw new Error(`existing-ads lookup failed: ${error.message}`)
      for (const r of data || []) existing.add(r.ad_id)
    }

    const toUpdate = records
      .filter(r => existing.has(r.ad_id))
      .map(r => ({
        ad_id: r.ad_id,
        status: r.status,
        effective_status: r.effective_status,
        last_synced_at: new Date().toISOString(),
      }))

    // Batched upsert — single round-trip per chunk instead of per row.
    let updated = 0
    const CHUNK_WRITE = 200
    for (let i = 0; i < toUpdate.length; i += CHUNK_WRITE) {
      const slice = toUpdate.slice(i, i + CHUNK_WRITE)
      const { error } = await supabase
        .from('ads')
        .upsert(slice, { onConflict: 'ad_id' })
      if (error) throw new Error(`batch ${i / CHUNK_WRITE} upsert failed: ${error.message}`)
      updated += slice.length
    }

    return new Response(JSON.stringify({
      success: true,
      adsSeen: records.length,
      adsUpdated: updated,
      adsSkipped: records.length - updated,
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
