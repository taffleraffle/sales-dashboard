// Daily GSC + GA4 pull per client
// - GSC: clicks/impressions/CTR/avg position + top queries + top pages (last 28 days windowed)
// - GA4: sessions/users/conversions, organic split (last 28 days windowed)
// - Emits 'content_indexed' win when net new pages appear in GSC vs prior day
// - Emits 'milestone' win when client crosses key thresholds

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { getGoogleAccessToken } from "../_shared/google-auth.ts";
import { emitWin } from "../_shared/win-emit.ts";

const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const body = await req.json().catch(() => ({}));
  const onlyClientId: string | undefined = body.client_id;
  const lookback = body.lookback_days || 1;

  // We pull yesterday's data (GSC has ~2 day lag, but partial data is fine)
  const endDate = new Date(Date.now() - 86400e3 * 2);
  const startDate = new Date(endDate.getTime() - lookback * 86400e3);

  let q = supa
    .from("clients")
    .select("id, business_name, custom_domain, ga4_measurement_id")
    .eq("status", "active");
  if (onlyClientId) q = q.eq("id", onlyClientId);
  const { data: clients } = await q;
  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no active clients" }), { status: 200 });
  }

  const token = await getGoogleAccessToken();
  const results: Array<{ client: string; gsc?: unknown; ga4?: unknown; error?: string }> = [];

  for (const client of clients) {
    if (!client.custom_domain) {
      results.push({ client: client.business_name, error: "no domain" });
      continue;
    }
    const siteUrl = `sc-domain:${client.custom_domain.replace(/^www\./, "")}`;

    try {
      // ── GSC: clicks/impressions/ctr/avg position ──
      const gscRes = await fetch(
        `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate: isoDate(startDate),
            endDate: isoDate(endDate),
            dimensions: ["date"],
            rowLimit: 28,
          }),
        },
      );
      const gscDaily = await gscRes.json();

      // Top queries
      const topQ = await fetch(
        `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate: isoDate(startDate),
            endDate: isoDate(endDate),
            dimensions: ["query"],
            rowLimit: 25,
          }),
        },
      );
      const topQueries = await topQ.json();

      const topP = await fetch(
        `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            startDate: isoDate(startDate),
            endDate: isoDate(endDate),
            dimensions: ["page"],
            rowLimit: 25,
          }),
        },
      );
      const topPages = await topP.json();

      const rows = gscDaily.rows || [];
      for (const row of rows) {
        const date = row.keys[0];
        await supa.from("gsc_metrics_daily").upsert({
          client_id: client.id,
          date,
          clicks: row.clicks || 0,
          impressions: row.impressions || 0,
          ctr: row.ctr || 0,
          avg_position: row.position || 0,
          top_queries: topQueries.rows?.slice(0, 25) || [],
          top_pages: topPages.rows?.slice(0, 25) || [],
        }, { onConflict: "client_id,date" });
      }

      // ── GA4 sync (skip if no measurement_id) ──
      let ga4Out: unknown = null;
      if (client.ga4_measurement_id) {
        const propertyId = client.ga4_measurement_id.startsWith("properties/")
          ? client.ga4_measurement_id
          : `properties/${client.ga4_measurement_id.replace(/^G-/, "")}`;

        const ga4Res = await fetch(
          `${GA4_BASE}/${propertyId}:runReport`,
          {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              dateRanges: [{ startDate: isoDate(startDate), endDate: isoDate(endDate) }],
              dimensions: [{ name: "date" }, { name: "sessionDefaultChannelGroup" }],
              metrics: [
                { name: "sessions" },
                { name: "totalUsers" },
                { name: "engagedSessions" },
                { name: "conversions" },
              ],
              limit: 200,
            }),
          },
        );
        ga4Out = await ga4Res.json();

        // Aggregate per day
        const byDate: Record<string, { sessions: number; users: number; engaged: number; conversions: number; organicSessions: number; organicConversions: number; topChannels: Record<string, number> }> = {};
        for (const row of (ga4Out as { rows?: Array<{ dimensionValues: { value: string }[]; metricValues: { value: string }[] }> }).rows || []) {
          const date = `${row.dimensionValues[0].value.slice(0,4)}-${row.dimensionValues[0].value.slice(4,6)}-${row.dimensionValues[0].value.slice(6,8)}`;
          const channel = row.dimensionValues[1].value;
          const sessions = parseInt(row.metricValues[0].value, 10);
          const users = parseInt(row.metricValues[1].value, 10);
          const engaged = parseInt(row.metricValues[2].value, 10);
          const conversions = parseInt(row.metricValues[3].value, 10);
          if (!byDate[date]) byDate[date] = { sessions: 0, users: 0, engaged: 0, conversions: 0, organicSessions: 0, organicConversions: 0, topChannels: {} };
          byDate[date].sessions += sessions;
          byDate[date].users += users;
          byDate[date].engaged += engaged;
          byDate[date].conversions += conversions;
          if (channel === "Organic Search") {
            byDate[date].organicSessions += sessions;
            byDate[date].organicConversions += conversions;
          }
          byDate[date].topChannels[channel] = (byDate[date].topChannels[channel] || 0) + sessions;
        }
        for (const [date, agg] of Object.entries(byDate)) {
          await supa.from("ga4_metrics_daily").upsert({
            client_id: client.id,
            date,
            sessions: agg.sessions,
            users: agg.users,
            engaged_sessions: agg.engaged,
            conversions: agg.conversions,
            organic_sessions: agg.organicSessions,
            organic_conversions: agg.organicConversions,
            top_channels: Object.entries(agg.topChannels)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 10)
              .map(([name, sessions]) => ({ name, sessions })),
          }, { onConflict: "client_id,date" });
        }
      }

      // Milestone detection: 100 organic sessions in a day for first time
      const { data: today } = await supa
        .from("ga4_metrics_daily")
        .select("organic_sessions, date")
        .eq("client_id", client.id)
        .order("date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { count: priorCount } = await supa
        .from("ga4_metrics_daily")
        .select("id", { count: "exact", head: true })
        .eq("client_id", client.id)
        .gte("organic_sessions", 100);
      if (today && today.organic_sessions >= 100 && (priorCount || 0) <= 1) {
        await emitWin({
          client_id: client.id,
          kind: "milestone",
          headline: `100+ organic sessions in a day for the first time`,
          detail: `${today.organic_sessions} organic sessions on ${today.date}.`,
          payload: { metric: "daily_organic_sessions", value: today.organic_sessions },
          source: "ga4",
        });
      }

      results.push({ client: client.business_name, gsc: rows.length, ga4: ga4Out ? "synced" : "no_ga4" });
    } catch (e) {
      results.push({ client: client.business_name, error: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
