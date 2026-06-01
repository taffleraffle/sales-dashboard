// WhatConverts webhook → client_leads + win emission on real state transitions
// URL: https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/whatconverts-webhook
//
// Uses the existing client_leads schema (lead_name, lead_phone, lead_email, external_ref,
// qualified, converted, deal_value, metadata) — NOT the previously-assumed contact_*/source_system
// columns which don't exist.
//
// Wins only fire on meaningful transitions:
//   - new lead created (always)
//   - lead becomes qualified (qualified flag flips false→true)
//   - sales_value attached/upgraded (deal closed event)

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
  phone_number?: string;
  email?: string;
  email_address?: string;
  message?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  keyword?: string;
  landing_url?: string;
  duration?: number | string;
  call_status?: string;
  call_recording?: string;
  quotable?: boolean | string;
  sales_value?: number | string;
  date_created?: string;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true" || v.toLowerCase() === "yes" || v === "1";
  return false;
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method not allowed" }), { status: 405 });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const lead = (await req.json()) as WCLead;

    // Find client by wc_account_id / wc_profile_id
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
      console.warn("WC lead no client match", { account: lead.account_id, profile: lead.profile_id });
      return new Response(JSON.stringify({ ok: true, matched: false }), { status: 200 });
    }

    // Read prior row state for transition detection
    const externalRef = String(lead.lead_id);
    const { data: prior } = await supa
      .from("client_leads")
      .select("id, qualified, deal_value, converted")
      .eq("client_id", clientId)
      .eq("external_ref", externalRef)
      .maybeSingle();

    const isQualified = toBool(lead.quotable);
    const incomingDealValue = toNumber(lead.sales_value);
    const phone = lead.phone || lead.phone_number;
    const email = lead.email || lead.email_address;
    const duration = toNumber(lead.duration);

    // Map WC lead_type to allowed channel CHECK values: call, form, chat, email, sms
    const channelMap: Record<string, string> = {
      "phone call": "call",
      "phone": "call",
      "call": "call",
      "text message": "sms",
      "sms": "sms",
      "web form": "form",
      "form": "form",
      "chat": "chat",
      "email": "email",
      "transaction": "form",
      "appointment": "form",
      "custom event": "form",
      "other": "form",
    };
    const rawType = (lead.lead_type || "call").toLowerCase().trim();
    const mappedChannel = channelMap[rawType] || "form";

    // Allowed source: organic, paid, direct, referral, gbp, social, email, other
    function mapAttributionSource(wcSource: string | undefined): string {
      if (!wcSource) return "other";
      const s = wcSource.toLowerCase();
      if (s.includes("organic") || (s.includes("google") && !s.includes("ads") && !s.includes("cpc") && !s.includes("gmb"))) return "organic";
      if (s.includes("gmb") || s.includes("business profile") || s.includes("google_my_business")) return "gbp";
      if (s.includes("cpc") || s.includes("paid") || s.includes("adwords") || s.includes("ads")) return "paid";
      if (s.includes("direct")) return "direct";
      if (s.includes("referral")) return "referral";
      if (s.includes("facebook") || s.includes("instagram") || s.includes("linkedin") || s.includes("social")) return "social";
      if (s.includes("email") || s.includes("newsletter")) return "email";
      return "other";
    }
    // Allowed status: new, qualified, disqualified, contacted, quoted, converted, lost, spam
    function mapStatus(qualified: boolean, dealValue: number | null, wcStatus: string | undefined): string {
      if (dealValue != null && dealValue > 0) return "converted";
      if (qualified) return "qualified";
      if (wcStatus) {
        const s = wcStatus.toLowerCase();
        if (s.includes("spam")) return "spam";
        if (s.includes("disqualif") || s.includes("rejected")) return "disqualified";
        if (s.includes("quoted")) return "quoted";
        if (s.includes("contact")) return "contacted";
        if (s.includes("lost")) return "lost";
      }
      return "new";
    }

    const row = {
      client_id: clientId,
      source: mapAttributionSource(lead.source),
      source_detail: lead.source || "whatconverts",
      channel: mappedChannel,
      lead_name: lead.contact_name || null,
      lead_phone: phone || null,
      lead_email: email || null,
      lead_message: lead.message || null,
      call_duration_sec: duration,
      call_recording_url: lead.call_recording || null,
      qualified: isQualified,
      qualified_at: isQualified ? (lead.date_created || new Date().toISOString()) : null,
      converted: incomingDealValue != null && incomingDealValue > 0,
      converted_at: incomingDealValue != null && incomingDealValue > 0 ? (lead.date_created || new Date().toISOString()) : null,
      deal_value: incomingDealValue,
      status: mapStatus(isQualified, incomingDealValue, lead.call_status),
      external_ref: externalRef,
      metadata: {
        wc_account_id: lead.account_id,
        wc_profile_id: lead.profile_id,
        wc_lead_id: lead.lead_id,
        medium: lead.medium,
        campaign: lead.campaign,
        keyword: lead.keyword,
        landing_url: lead.landing_url,
        date_created: lead.date_created,
        raw: lead,
      },
    };

    const { data: leadRow, error } = await supa
      .from("client_leads")
      .upsert(row, { onConflict: "client_id,external_ref" })
      .select("id")
      .single();

    if (error) {
      console.error("client_leads upsert error:", error);
      return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
    }

    // Win emission rules
    const winEvents: Array<{ kind: "new_lead" | "milestone"; headline: string; detail: string }> = [];

    if (!prior) {
      // brand new lead
      const headline = isQualified
        ? `New qualified lead: ${lead.contact_name || phone || "unknown"}`
        : `New lead: ${lead.contact_name || phone || "unknown"}`;
      const detail = [
        lead.lead_type ? `*Type:* ${lead.lead_type}` : null,
        lead.source ? `*Source:* ${lead.source}` : null,
        lead.keyword ? `*Keyword:* ${lead.keyword}` : null,
        incomingDealValue ? `*Value:* $${incomingDealValue.toLocaleString()}` : null,
      ].filter(Boolean).join(" · ");
      winEvents.push({ kind: "new_lead", headline, detail });
    } else {
      // existing lead — only meaningful transitions emit wins
      if (isQualified && !prior.qualified) {
        winEvents.push({
          kind: "new_lead",
          headline: `Lead qualified: ${lead.contact_name || phone || "unknown"}`,
          detail: lead.keyword ? `*Keyword:* ${lead.keyword}` : "Marked qualified.",
        });
      }
      const priorValue = Number(prior.deal_value) || 0;
      if (incomingDealValue != null && incomingDealValue > priorValue && incomingDealValue > 0) {
        winEvents.push({
          kind: "milestone",
          headline: `Deal closed: $${incomingDealValue.toLocaleString()} from ${lead.contact_name || phone || "lead"}`,
          detail: [
            lead.keyword ? `*Keyword:* ${lead.keyword}` : null,
            lead.source ? `*Source:* ${lead.source}` : null,
          ].filter(Boolean).join(" · "),
        });
      }
    }

    for (const evt of winEvents) {
      await emitWin({
        client_id: clientId,
        kind: evt.kind,
        headline: evt.headline,
        detail: evt.detail,
        payload: { lead_id: lead.lead_id, account_id: lead.account_id, profile_id: lead.profile_id, deal_value: incomingDealValue },
        source: "whatconverts",
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      matched: true,
      lead_row_id: leadRow.id,
      win_emitted: winEvents.length > 0,
      win_kinds: winEvents.map((e) => e.kind),
    }), { status: 200 });
  } catch (e) {
    console.error("wc webhook exception:", e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500 });
  }
});
