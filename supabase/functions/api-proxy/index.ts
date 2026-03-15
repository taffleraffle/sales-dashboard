import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Verify caller is authenticated
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user } } = await callerClient.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { service, action, params } = await req.json()

    // ── Meta Ads ──
    if (service === 'meta') {
      const accountId = Deno.env.get('META_ADS_ACCOUNT_ID')
      const accessToken = Deno.env.get('META_ADS_ACCESS_TOKEN')
      if (!accountId || !accessToken) {
        return new Response(JSON.stringify({ error: 'Meta Ads not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const searchParams = new URLSearchParams({
        access_token: accessToken,
        level: params.level || 'adset',
        fields: params.fields || 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,actions,cost_per_action_type,cpc,ctr',
        time_range: JSON.stringify({ since: params.since, until: params.until }),
        time_increment: '1',
        limit: '500',
      })
      const url = `https://graph.facebook.com/v21.0/act_${accountId}/insights?${searchParams}`
      const res = await fetch(url)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error?.message || `Meta API ${res.status}`)
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── GHL ──
    if (service === 'ghl') {
      const apiKey = Deno.env.get('GHL_API_KEY')
      const locationId = Deno.env.get('GHL_LOCATION_ID')
      if (!apiKey || !locationId) {
        return new Response(JSON.stringify({ error: 'GHL not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const ghlHeaders = {
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
      }

      if (action === 'contacts') {
        const sp = new URLSearchParams({ locationId, limit: params.limit || '100' })
        if (params.query) sp.set('query', params.query)
        if (params.startAfterId) sp.set('startAfterId', params.startAfterId)
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/?${sp}`, { headers: ghlHeaders })
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (action === 'appointments') {
        const res = await fetch(
          `https://services.leadconnectorhq.com/contacts/${params.contactId}/appointments`,
          { headers: ghlHeaders }
        )
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (action === 'calendars') {
        const res = await fetch(
          `https://services.leadconnectorhq.com/calendars/?locationId=${locationId}`,
          { headers: ghlHeaders }
        )
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (action === 'pipelines') {
        const res = await fetch(
          `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`,
          { headers: ghlHeaders }
        )
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (action === 'opportunities') {
        const sp = new URLSearchParams({ location_id: locationId, limit: params.limit || '100' })
        if (params.pipelineId) sp.set('pipeline_id', params.pipelineId)
        if (params.status) sp.set('status', params.status)
        const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${sp}`, {
          method: 'GET', headers: ghlHeaders,
        })
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (action === 'contact_search') {
        const sp = new URLSearchParams({ locationId, query: params.query || '', limit: '20' })
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/?${sp}`, { headers: ghlHeaders })
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ error: `Unknown GHL action: ${action}` }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Fathom ──
    if (service === 'fathom') {
      const apiKey = Deno.env.get('FATHOM_API_KEY')
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Fathom not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const endpoint = params.endpoint || '/meetings'
      const url = new URL(`https://api.fathom.ai/external/v1${endpoint}`)
      if (params.queryParams) {
        for (const [k, v] of Object.entries(params.queryParams)) {
          url.searchParams.set(k, String(v))
        }
      }
      const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } })
      const data = await res.json()
      if (!res.ok) throw new Error(`Fathom API ${res.status}`)
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Hyros ──
    if (service === 'hyros') {
      const apiKey = Deno.env.get('HYROS_API_KEY')
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Hyros not configured' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const res = await fetch(`https://api.hyros.com/v1/api/attribution/report`, {
        method: 'POST',
        headers: { 'API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(params.body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`Hyros API ${res.status}`)
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: `Unknown service: ${service}` }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
