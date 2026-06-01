// WhatConverts 90-day historical backfill
// Pulls all leads across all profiles, matches to ROM clients, inserts to client_leads.
// Does NOT emit wins for historical leads (would spam the channel).
//
// Trigger:
//   curl -X POST https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-backfill \
//     -H "Authorization: Bearer <service_role_key>" -H "Content-Type: application/json" \
//     -d '{"days":90}'

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const WC_BASE = "https://app.whatconverts.com/api/v1";

function basicAuth(): string {
  const token = Deno.env.get("WHATCONVERTS_API_TOKEN")!;
  const secret = Deno.env.get("WHATCONVERTS_API_SECRET")!;
  return "Basic " + btoa(`${token}:${secret}`);
}

interface WCLeadAPI {
  lead_id: number;
  account_id?: number;
  profile_id?: number;
  lead_type?: string;
  contact_name?: string;
  phone_number?: string;
  email_address?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  keyword?: string;
  landing_url?: string;
  duration?: string;
  call_status?: string;
  quotable?: string;
  sales_value?: number;
  date_created?: string;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { days = 90 } = await req.json().catch(() => ({ days: 90 }));
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);

  // Get all ROM clients with WC profile mappings
  const { data: clients } = await supa
    .from("clients")
    .select("id, business_name, wc_account_id, wc_profile_id")
    .or("wc_account_id.not.is.null,wc_profile_id.not.is.null");

  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients with WC mapping" }), { status: 200 });
  }

  const summary: Record<string, { fetched: number; inserted: number }> = {};
  let totalFetched = 0;
  let totalInserted = 0;

  for (const client of clients) {
    const accountId = client.wc_account_id;
    const profileId = client.wc_profile_id;
    if (!accountId) continue;

    let page = 1;
    let clientFetched = 0;
    let clientInserted = 0;

    while (true) {
      const params = new URLSearchParams({
        account_id: String(accountId),
        start_date: since,
        page_number: String(page),
        leads_per_page: "250",
      });
      if (profileId) params.append("profile_id", String(profileId));

      const wcRes = await fetch(`${WC_BASE}/leads?${params.toString()}`, {
        headers: { "Authorization": basicAuth() },
      });
      if (!wcRes.ok) {
        console.error(`WC ${client.business_name} page ${page}: ${wcRes.status}`);
        break;
      }
      const wcData = await wcRes.json();
      const leads: WCLeadAPI[] = wcData.leads || [];
      if (leads.length === 0) break;
      clientFetched += leads.length;

      const rows = leads.map((l) => ({
        client_id: client.id,
        source_system: "whatconverts",
        source_id: String(l.lead_id),
        lead_type: l.lead_type || "call",
        contact_name: l.contact_name,
        contact_phone: l.phone_number,
        contact_email: l.email_address,
        source: l.source,
        medium: l.medium,
        campaign: l.campaign,
        keyword: l.keyword,
        landing_url: l.landing_url,
        call_duration_seconds: l.duration ? parseInt(l.duration, 10) : null,
        call_status: l.call_status,
        quotable: l.quotable === "true" || l.quotable === "Yes",
        sales_value: l.sales_value,
        received_at: l.date_created || new Date().toISOString(),
        raw: l,
      }));

      const { error } = await supa
        .from("client_leads")
        .upsert(rows, { onConflict: "source_system,source_id" });
      if (error) console.error("upsert err:", error.message);
      else clientInserted += rows.length;

      if (leads.length < 250) break;
      page++;
      if (page > 50) break; // safety
    }

    summary[client.business_name] = { fetched: clientFetched, inserted: clientInserted };
    totalFetched += clientFetched;
    totalInserted += clientInserted;
  }

  return new Response(JSON.stringify({
    ok: true,
    days_back: days,
    total_fetched: totalFetched,
    total_inserted: totalInserted,
    per_client: summary,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
});
