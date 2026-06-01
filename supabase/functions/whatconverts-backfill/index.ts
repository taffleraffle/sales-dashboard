// WhatConverts 90-day backfill — uses the real client_leads schema.
// Pulls historical leads across all clients with wc_account_id set,
// upserts to client_leads (no win emission for historical).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const WC_BASE = "https://app.whatconverts.com/api/v1";

function basicAuth(): string {
  const token = Deno.env.get("WHATCONVERTS_API_TOKEN")!;
  const secret = Deno.env.get("WHATCONVERTS_API_SECRET")!;
  return "Basic " + btoa(`${token}:${secret}`);
}

interface WCLead {
  lead_id: number | string;
  account_id?: number;
  profile_id?: number;
  lead_type?: string;
  contact_name?: string;
  phone_number?: string;
  phone?: string;
  email_address?: string;
  email?: string;
  message?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  keyword?: string;
  landing_url?: string;
  duration?: string | number;
  call_status?: string;
  call_recording?: string;
  quotable?: string | boolean;
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
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { days = 90 } = await req.json().catch(() => ({ days: 90 }));
  const since = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);

  const { data: clients } = await supa
    .from("clients")
    .select("id, business_name, wc_account_id, wc_profile_id")
    .not("wc_account_id", "is", null);

  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients with WC mapping" }), { status: 200 });
  }

  const summary: Record<string, { fetched: number; inserted: number; errors: number; sample_error?: string }> = {};
  let totalFetched = 0;
  let totalInserted = 0;

  for (const client of clients) {
    const accountId = client.wc_account_id;
    const profileId = client.wc_profile_id;
    if (!accountId) continue;

    let page = 1;
    let clientFetched = 0;
    let clientInserted = 0;
    let clientErrors = 0;
    let sampleError: string | undefined;

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
      const leads: WCLead[] = wcData.leads || [];
      if (leads.length === 0) break;
      clientFetched += leads.length;

      const channelMap: Record<string, string> = {
        "phone call": "call", "phone": "call", "call": "call",
        "text message": "sms", "sms": "sms",
        "web form": "form", "form": "form",
        "chat": "chat", "email": "email",
        "transaction": "form", "appointment": "form", "custom event": "form", "other": "form",
      };
      // Allowed source CHECK: organic, paid, direct, referral, gbp, social, email, other
      function mapAttributionSource(wcSource: string | undefined): string {
        if (!wcSource) return "other";
        const s = wcSource.toLowerCase();
        if (s.includes("organic") || s.includes("google") && !s.includes("ads") && !s.includes("cpc") && !s.includes("gmb")) return "organic";
        if (s.includes("gmb") || s.includes("business profile") || s.includes("google_my_business")) return "gbp";
        if (s.includes("cpc") || s.includes("paid") || s.includes("adwords") || s.includes("ads")) return "paid";
        if (s.includes("direct")) return "direct";
        if (s.includes("referral")) return "referral";
        if (s.includes("facebook") || s.includes("instagram") || s.includes("linkedin") || s.includes("social")) return "social";
        if (s.includes("email") || s.includes("newsletter")) return "email";
        return "other";
      }
      // Allowed status CHECK: new, qualified, disqualified, contacted, quoted, converted, lost, spam
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

      const rows = leads.map((l) => {
        const isQualified = toBool(l.quotable);
        const dealValue = toNumber(l.sales_value);
        const duration = toNumber(l.duration);
        const phone = l.phone_number || l.phone;
        const email = l.email_address || l.email;
        const rawType = (l.lead_type || "call").toLowerCase().trim();
        const channel = channelMap[rawType] || "form";

        return {
          client_id: client.id,
          source: mapAttributionSource(l.source),
          source_detail: l.source || "whatconverts",
          channel,
          lead_name: l.contact_name || null,
          lead_phone: phone || null,
          lead_email: email || null,
          lead_message: l.message || null,
          call_duration_sec: duration,
          call_recording_url: l.call_recording || null,
          qualified: isQualified,
          qualified_at: isQualified ? (l.date_created || null) : null,
          converted: dealValue != null && dealValue > 0,
          converted_at: dealValue != null && dealValue > 0 ? (l.date_created || null) : null,
          deal_value: dealValue,
          status: mapStatus(isQualified, dealValue, l.call_status),
          external_ref: String(l.lead_id),
          metadata: {
            wc_account_id: l.account_id,
            wc_profile_id: l.profile_id,
            wc_lead_id: l.lead_id,
            medium: l.medium,
            campaign: l.campaign,
            keyword: l.keyword,
            landing_url: l.landing_url,
            date_created: l.date_created,
            raw: l,
          },
        };
      });

      const { error } = await supa
        .from("client_leads")
        .upsert(rows, { onConflict: "client_id,external_ref" });
      if (error) {
        clientErrors++;
        if (!sampleError) sampleError = error.message;
        console.error("upsert err:", error.message);
      } else {
        clientInserted += rows.length;
      }

      if (leads.length < 250) break;
      page++;
      if (page > 100) break;
    }

    summary[client.business_name] = { fetched: clientFetched, inserted: clientInserted, errors: clientErrors, sample_error: sampleError };
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
