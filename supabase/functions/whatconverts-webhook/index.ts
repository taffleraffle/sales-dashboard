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

    // Win emission rules — signal not noise.
    // Individual leads are SILENT. Fire only on:
    //   1. AI-sourced lead (ChatGPT, Perplexity, Gemini etc cited the client → traffic landed)
    //   2. Deal closed (sales_value attached)
    //   3. Personal best: today's lead count exceeds prior best for this client
    //   4. Milestone counts: 50/100/250/500/1000 leads this month, etc.
    const winEvents: Array<{ kind: "new_lead" | "milestone"; headline: string; detail: string }> = [];

    // ── 1. AI-sourced lead detection ──
    function detectAISource(): string | null {
      const haystack = [lead.source, lead.medium, lead.campaign, lead.landing_url, lead.keyword]
        .filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes("chatgpt") || haystack.includes("openai")) return "ChatGPT";
      if (haystack.includes("perplexity")) return "Perplexity";
      if (haystack.includes("gemini") || haystack.includes("bard")) return "Gemini";
      if (haystack.includes("claude.ai")) return "Claude";
      if (haystack.includes("copilot")) return "Copilot";
      if (haystack.includes("ai-overview") || haystack.includes("aio") || haystack.includes("google_ai")) return "Google AI Overviews";
      return null;
    }

    if (!prior) {
      // brand new lead — silent unless AI-sourced
      const aiSource = detectAISource();
      if (aiSource) {
        winEvents.push({
          kind: "new_lead",
          headline: `${aiSource} drove a lead`,
          detail: [
            lead.keyword ? `*Query:* "${lead.keyword}"` : null,
            lead.lead_type ? `*Type:* ${lead.lead_type}` : null,
            incomingDealValue ? `*Value:* $${incomingDealValue.toLocaleString()}` : null,
          ].filter(Boolean).join(" · "),
        });
      }

      // ── 3. Personal best detection: today's leads vs prior daily best ──
      // Only fire once daily count crosses prior best (not on every subsequent lead today)
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const { count: todayCount } = await supa
        .from("client_leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .gte("created_at", todayStart.toISOString());

      const { data: clientMeta } = await supa
        .from("clients")
        .select("client_json, business_name")
        .eq("id", clientId)
        .single();
      const cj = (clientMeta?.client_json || {}) as { records?: { best_daily_leads?: number } };
      const priorBest = cj.records?.best_daily_leads || 0;

      if ((todayCount || 0) > priorBest && (todayCount || 0) >= 5) {
        // Only fire if we crossed it on THIS insert (today's count just hit priorBest + 1)
        if ((todayCount || 0) === priorBest + 1) {
          winEvents.push({
            kind: "milestone",
            headline: `Best lead day ever: ${todayCount} leads`,
            detail: `Prior best: ${priorBest}. ${lead.source ? `Latest from ${lead.source}.` : ""}`,
          });
          // persist the new record
          const newRecords = { ...(cj.records || {}), best_daily_leads: todayCount };
          await supa.from("clients").update({ client_json: { ...cj, records: newRecords } }).eq("id", clientId);
        }
      }

      // ── 4. Round-number milestone detection (monthly leads) ──
      const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
      const { count: monthCount } = await supa
        .from("client_leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .gte("created_at", monthStart.toISOString());

      const LEAD_MILESTONES = [50, 100, 250, 500, 1000];
      for (const ms of LEAD_MILESTONES) {
        if ((monthCount || 0) === ms) {
          const monthName = monthStart.toLocaleString("en-US", { month: "long" });
          winEvents.push({
            kind: "milestone",
            headline: `${ms} leads this ${monthName.toLowerCase()}`,
            detail: `Client just crossed ${ms} inbound leads for the month.`,
          });
          break;
        }
      }
    } else {
      // Existing lead update — only fire on:
      //   - Deal closed (sales_value attached or upgraded)
      // qualified flip is no longer client-wins material; track silently
      const priorValue = Number(prior.deal_value) || 0;
      if (incomingDealValue != null && incomingDealValue > priorValue && incomingDealValue > 0) {
        winEvents.push({
          kind: "milestone",
          headline: `Deal closed: $${incomingDealValue.toLocaleString()}`,
          detail: [
            lead.contact_name ? `${lead.contact_name}` : null,
            lead.keyword ? `*Keyword:* ${lead.keyword}` : null,
            lead.source ? `*Source:* ${lead.source}` : null,
          ].filter(Boolean).join(" · "),
        });

        // Also detect monthly revenue milestone
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        const { data: monthDeals } = await supa
          .from("client_leads")
          .select("deal_value")
          .eq("client_id", clientId)
          .eq("converted", true)
          .gte("converted_at", monthStart.toISOString());
        const monthRev = (monthDeals || []).reduce((s, d) => s + (Number(d.deal_value) || 0), 0);
        const REV_MILESTONES = [5000, 10000, 25000, 50000, 100000];
        for (const ms of REV_MILESTONES) {
          if (monthRev >= ms && (monthRev - incomingDealValue) < ms) {
            winEvents.push({
              kind: "milestone",
              headline: `$${ms.toLocaleString()} attributable revenue this month`,
              detail: `Client just crossed $${ms.toLocaleString()} in tracked closed deals for the month.`,
            });
            break;
          }
        }
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
