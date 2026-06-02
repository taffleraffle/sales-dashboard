// Edge Function: create-portal-link
//
// Looks up a Stripe customer by email, creates a fresh billing portal
// session, and returns the URL. Called by the seo-dashboard chase-email
// cron when it needs to embed a per-client "update payment details" link.
//
// Reuses the existing STRIPE_SECRET_KEY secret already in this project
// (used by sync-stripe-payments + stripe-webhook) — no key duplication.
//
// Auth: shared secret header. Caller (seo-dashboard) sends
//   x-portal-secret: <PORTAL_LINK_SECRET>
// matching the secret stored in this project's Edge Function secrets.
//
// Request:  POST { email: string, return_url?: string }
// Response: 200 { url, customer_id }
//           400 { error: "email required" }
//           401 { error: "unauthorized" }
//           404 { error: "no customer found for email" }
//           500 { error: "..." }
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-portal-secret, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const portalSecret = Deno.env.get('PORTAL_LINK_SECRET')
    if (!portalSecret) {
      return new Response(JSON.stringify({ error: 'PORTAL_LINK_SECRET not configured on Edge Function' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const providedSecret = req.headers.get('x-portal-secret') || ''
    if (providedSecret !== portalSecret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY')
    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY not configured')

    let body: { email?: string; return_url?: string }
    try {
      body = await req.json()
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const email = (body.email || '').trim().toLowerCase()
    if (!email) {
      return new Response(JSON.stringify({ error: 'email required in body' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const returnUrl = body.return_url || 'https://opt.co.nz'

    // 1. Find Stripe customer by email
    const lookupRes = await fetch(
      `https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`,
      { headers: { 'Authorization': `Bearer ${stripeKey}` } },
    )
    if (!lookupRes.ok) {
      const text = await lookupRes.text()
      throw new Error(`Stripe customer lookup failed: ${text.slice(0, 200)}`)
    }
    const lookupData = await lookupRes.json()
    const customer = (lookupData.data || [])[0]
    if (!customer) {
      return new Response(JSON.stringify({ error: 'no customer found for email', email }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2. Create billing portal session
    const sessionForm = new URLSearchParams()
    sessionForm.append('customer', customer.id)
    sessionForm.append('return_url', returnUrl)
    const sessionRes = await fetch(
      'https://api.stripe.com/v1/billing_portal/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: sessionForm.toString(),
      },
    )
    if (!sessionRes.ok) {
      const text = await sessionRes.text()
      throw new Error(`Stripe billing portal session failed: ${text.slice(0, 300)}`)
    }
    const session = await sessionRes.json()

    return new Response(JSON.stringify({
      url: session.url,
      customer_id: customer.id,
      customer_email: customer.email,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message || err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
