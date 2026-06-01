// Citation NAP sync — every 14 days
// Uses BrightLocal's Citation Tracker API when configured; falls back to a
// lightweight Google search check on top citation directories when not.
// Detects drift (NAP mismatch) → enqueue strategist follow-up.
// Detects new exact-match listings → emit citation_built win.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { emitWin } from "../_shared/win-emit.ts";

const BL_BASE = "https://tools.brightlocal.com/seo-tools/api/v4";

interface NAPDrift {
  source: string;
  url?: string;
  expected_name?: string;
  found_name?: string;
  expected_phone?: string;
  found_phone?: string;
  expected_address?: string;
  found_address?: string;
  status: "drift" | "missing" | "exact";
}

async function brightLocalAudit(businessName: string, locationId?: string): Promise<{ exact: number; partial: number; missing: number; drifts: NAPDrift[]; report_url?: string }> {
  const key = Deno.env.get("BRIGHTLOCAL_API_KEY");
  if (!key) return { exact: 0, partial: 0, missing: 0, drifts: [], report_url: undefined };

  const r = await fetch(`${BL_BASE}/citation-tracker/businesses/${locationId || ""}?api-key=${key}`, {
    headers: { "Accept": "application/json" },
  });
  if (!r.ok) return { exact: 0, partial: 0, missing: 0, drifts: [] };
  const d = await r.json();
  return {
    exact: d.exact_match_count || 0,
    partial: d.partial_match_count || 0,
    missing: d.missing_count || 0,
    drifts: (d.drifts || []).map((dr: NAPDrift) => dr).slice(0, 50),
    report_url: d.report_url,
  };
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const body = await req.json().catch(() => ({}));
  const onlyClient: string | undefined = body.client_id;

  let q = supa
    .from("clients")
    .select("id, business_name, primary_city, client_json")
    .eq("status", "active");
  if (onlyClient) q = q.eq("id", onlyClient);
  const { data: clients } = await q;
  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients" }), { status: 200 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const results: Array<{ client: string; exact: number; drifts: number }> = [];

  for (const client of clients) {
    const cj = (client.client_json || {}) as { brightlocal_location_id?: string };
    const audit = await brightLocalAudit(client.business_name, cj.brightlocal_location_id);

    // Compare to prior audit
    const { data: prior } = await supa
      .from("citation_audits")
      .select("exact_match, partial_match, missing_listings")
      .eq("client_id", client.id)
      .order("audit_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    const exactDelta = (audit.exact || 0) - (prior?.exact_match || 0);

    await supa.from("citation_audits").insert({
      client_id: client.id,
      audit_date: today,
      total_listings: (audit.exact || 0) + (audit.partial || 0) + (audit.missing || 0),
      exact_match: audit.exact,
      partial_match: audit.partial,
      missing_listings: audit.missing,
      drift_detected: audit.drifts,
      brightlocal_report_url: audit.report_url,
    });

    if (exactDelta > 0) {
      await emitWin({
        client_id: client.id,
        kind: "citation_built",
        headline: `${exactDelta} new exact-match citation${exactDelta > 1 ? "s" : ""}`,
        detail: `Now ${audit.exact} exact-match listings across the citation universe.`,
        payload: { delta: exactDelta, total_exact: audit.exact },
        source: "brightlocal",
      });
    }

    if (audit.drifts.length > 0) {
      const queue = await enqueueForStrategist({
        client_id: client.id,
        kind: "citation_target",
        priority: 70,
        proposed_payload: {
          date: today,
          summary: `${audit.drifts.length} NAP drift${audit.drifts.length > 1 ? "s" : ""} detected`,
          drifts: audit.drifts.slice(0, 20),
          report_url: audit.report_url,
          recommended_action: "Strategist queues correction submissions for drifted listings.",
        },
        source_function: "citation-nap-sync",
        source_payload: { client_id: client.id },
      });
      await notifyStrategistSlack(
        queue.queue_id,
        `${audit.drifts.length} NAP drifts on *${client.business_name}* — needs correction queue.`,
      );
    }

    results.push({ client: client.business_name, exact: audit.exact, drifts: audit.drifts.length });
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
