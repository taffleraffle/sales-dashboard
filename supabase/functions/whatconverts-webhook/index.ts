// WhatConverts webhook → client_leads + win emission
// Paste this URL into WhatConverts admin under Webhooks:
//   https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-webhook
//
// WC sends a JSON body with fields: lead_id, account_id, profile_id, lead_type,
// contact_name, phone, email, source, medium, campaign, keyword, landing_url,
// duration, call_status, quotable, sales_value, date_created, etc.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { emitWin } from "../_shared/win-emit.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface WCLead {
  lead_id: string | number;
  account_id?: string | number;
  profile_id?: string | number;
  lead_type?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  keyword?: string;
  landing_url?: string;
  duration?: number;
  call_status?: string;
  quotable?: boolean | string;
  sales_value?: number;
  date_created?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), {
      status: 405,
    });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const lead = (await req.json()) as WCLead;

    // Find which ROM client this WC profile belongs to
    let clientId: string | null = null;
    if (lead.profile_id) {
      const { data: client } = await supa
        .from("clients")
        .select("id, business_name")
        .eq("wc_profile_id", String(lead.profile_id))
        .maybeSingle();
      if (client) clientId = client.id;
    }
    if (!clientId && lead.account_id) {
      const { data: client } = await supa
        .from("clients")
        .select("id, business_name")
        .eq("wc_account_id", String(lead.account_id))
        .maybeSingle();
      if (client) clientId = client.id;
    }

    if (!clientId) {
      console.warn("WC lead with no matching client", { account: lead.account_id, profile: lead.profile_id });
      return new Response(JSON.stringify({ ok: true, matched: false }), { status: 200 });
    }

    // Read existing row state first so we can detect change kind
    const { data: prior } = await supa
      .from("client_leads")
      .select("id, quotable, sales_value, converted")
      .eq("source_system", "whatconverts")
      .eq("source_id", String(lead.lead_id))
      .maybeSingle();

    const isQuotable = typeof lead.quotable === "boolean" ? lead.quotable : lead.quotable === "true";
    const incomingSalesValue = lead.sales_value ? Number(lead.sales_value) : null;

    // Upsert
    const { data: leadRow, error } = await supa
      .from("client_leads")
      .upsert(
        {
          client_id: clientId,
          source_system: "whatconverts",
          source_id: String(lead.lead_id),
          lead_type: lead.lead_type || "call",
          contact_name: lead.contact_name,
          contact_phone: lead.phone,
          contact_email: lead.email,
          source: lead.source,
          medium: lead.medium,
          campaign: lead.campaign,
          keyword: lead.keyword,
          landing_url: lead.landing_url,
          call_duration_seconds: lead.duration,
          call_status: lead.call_status,
          quotable: isQuotable,
          sales_value: incomingSalesValue,
          received_at: lead.date_created || new Date().toISOString(),
          raw: lead,
        },
        { onConflict: "source_system,source_id" },
      )
      .select("id")
      .single();

    if (error) {
      console.error("lead insert error:", error);
    }

    if (!leadRow) {
      return new Response(JSON.stringify({ ok: false, error: "upsert returned no row" }), { status: 500 });
    }

    // Decide what wins (if any) to emit based on state transition
    const winEvents: Array<{ kind: "new_lead" | "milestone"; headline: string; detail: string }> = [];

    if (!prior) {
      // BRAND NEW LEAD
      const headline = isQuotable
        ? `New quotable lead: ${lead.contact_name || lead.phone || "unknown"}`
        : `New lead: ${lead.contact_name || lead.phone || "unknown"}`;
      const detail = [
        lead.lead_type ? `*Type:* ${lead.lead_type}` : null,
        lead.source ? `*Source:* ${lead.source}` : null,
        lead.keyword ? `*Keyword:* ${lead.keyword}` : null,
        incomingSalesValue ? `*Value:* $${incomingSalesValue.toLocaleString()}` : null,
      ].filter(Boolean).join(" · ");
      winEvents.push({ kind: "new_lead", headline, detail });
    } else {
      // EXISTING LEAD UPDATE — emit only on meaningful state transitions
      // 1. Became quotable (prior was false/null, now true)
      if (isQuotable && !prior.quotable) {
        winEvents.push({
          kind: "new_lead",
          headline: `Lead qualified: ${lead.contact_name || lead.phone || "unknown"}`,
          detail: `Marked quotable. ${lead.keyword ? `*Keyword:* ${lead.keyword}` : ""}`,
        });
      }
      // 2. Sales value attached or upgraded (only fire on increase from null or significant uplift)
      if (incomingSalesValue && (!prior.sales_value || incomingSalesValue > Number(prior.sales_value))) {
        winEvents.push({
          kind: "milestone",
          headline: `Deal closed: $${incomingSalesValue.toLocaleString()} from ${lead.contact_name || lead.phone || "lead"}`,
          detail: `${lead.keyword ? `*Keyword:* ${lead.keyword} · ` : ""}${lead.source ? `*Source:* ${lead.source}` : ""}`,
        });
      }
      // 3. Other updates → silently update the row, no wins emission
    }

    if (winEvents.length === 0) {
      return new Response(JSON.stringify({ ok: true, matched: true, lead_row_id: leadRow.id, win_emitted: false, reason: prior ? "no_meaningful_transition" : "?" }), { status: 200 });
    }

    // Fire each win event
    for (const evt of winEvents) {
      await emitWin({
        client_id: clientId,
        kind: evt.kind,
        headline: evt.headline,
        detail: evt.detail,
        payload: { lead_id: lead.lead_id, profile_id: lead.profile_id, sales_value: incomingSalesValue },
        source: "whatconverts",
      });
    }

    return new Response(JSON.stringify({ ok: true, matched: true, lead_row_id: leadRow.id, win_emitted: true, win_kinds: winEvents.map((e) => e.kind) }), { status: 200 });
  } catch (e) {
    console.error("wc webhook exception:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
