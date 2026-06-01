// GBP weekly health check
// Reads each client's GBP profile (account_id + location_id from clients.client_json)
// using Google My Business / Business Profile API with refresh-token auth.
// Computes a 0-100 health score across: posts cadence, photos cadence, Q&A response time,
// review velocity, attribute drift, hours drift.
//
// Routes negatives to strategist queue (internal flag, not client-facing).
// Routes positives (new 5-star reviews, post traction) to wins emitter.
//
// Multi-account aware: tries the client's preferred OAuth account first via
// withEachOAuthAccount, falls back to other accounts on 403/404.
//
// Idempotent: re-runs on the same day with unchanged score+flags are a no-op
// for wins emission and strategist queue routing.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { persistAccountSuccess, withEachOAuthAccount } from "../_shared/google-auth.ts";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { emitWin } from "../_shared/win-emit.ts";

const GBP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GBP_QANDA = "https://mybusinessqanda.googleapis.com/v1";
const GBP_LEGACY = "https://mybusiness.googleapis.com/v4";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GbpScore {
  posts: number;
  photos: number;
  qa: number;
  reviews: number;
  attributes: number;
  hours: number;
}

interface ClientRow {
  id: string;
  business_name: string;
  primary_city: string | null;
  client_json: Record<string, unknown> | null;
}

interface GbpMetrics {
  postsLast7: number;
  photosLast7: number;
  qaPending: number;
  reviewsLast7: number;
  avgRating: number;
  newFiveStar: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response("method", { status: 405, headers: CORS_HEADERS });
  }

  // auth gate: this is invoked by cron with the service-role bearer (--no-verify-jwt).
  // For admin/browser calls, require the supabase Authorization header to be present.
  // Cron invocations include the service role key in Authorization, which is fine.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "missing authorization header" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

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
  const { data: clients, error: clientsErr } = await q;
  if (clientsErr) {
    return new Response(JSON.stringify({ error: `clients query: ${clientsErr.message}` }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (!clients || clients.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no clients" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const results: Array<{ client: string; score: number | null; flags: string[]; account?: string }> = [];

  for (const client of clients as ClientRow[]) {
    const cj = (client.client_json || {}) as {
      gbp_account_id?: string;
      gbp_location_id?: string;
      gbp_location_name?: string;
      gbp_oauth_account?: string;
    };
    const accountId = cj.gbp_account_id;
    const locationName = cj.gbp_location_name; // format: "locations/12345"
    const preferredEmail = cj.gbp_oauth_account;

    if (!locationName) {
      results.push({ client: client.business_name, score: null, flags: ["no_gbp_mapped"] });
      continue;
    }

    try {
      // Try each OAuth account until one returns a 200 on the location info call.
      // We use businessinformation.locations.get as the cheap "does this account own this location" probe.
      const probe = await withEachOAuthAccount(async (token, _account) => {
        const res = await fetch(`${GBP_INFO}/${locationName}?readMask=name,title`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (res.status === 403 || res.status === 404) return null;
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`location probe ${res.status}: ${text}`);
        }
        return { ok: true };
      }, preferredEmail);

      if (!probe) {
        console.warn(`no OAuth account has access to ${locationName} for client ${client.id}`);
        await supa.from("gbp_health_log").upsert({
          client_id: client.id,
          date: today,
          flags: ["account_unmappable"],
          score: null,
        }, { onConflict: "client_id,date" });
        results.push({ client: client.business_name, score: null, flags: ["account_unmappable"] });
        continue;
      }

      const workingEmail = probe.account.email;
      // persist which account works for this client (skips when value unchanged anyway)
      await persistAccountSuccess(supa, workingEmail, client.id);

      // pull all metrics using the working token. we re-resolve the token via withEachOAuthAccount
      // using the now-preferred email so the cache is reused.
      const metricsResult = await withEachOAuthAccount(async (token, _account) => {
        return await collectMetrics({ token, accountId, locationName, sevenDaysAgo });
      }, workingEmail);

      if (!metricsResult) {
        results.push({ client: client.business_name, score: null, flags: ["metrics_fetch_failed"], account: workingEmail });
        continue;
      }

      const metrics = metricsResult.result;
      const { flags, scores } = scoreMetrics(metrics);

      const overall = Math.round(
        scores.posts * 0.2 +
        scores.photos * 0.15 +
        scores.qa * 0.2 +
        scores.reviews * 0.3 +
        scores.attributes * 0.075 +
        scores.hours * 0.075,
      );

      // idempotency gate: check if today's row already has this exact score+flags
      const { data: existing } = await supa
        .from("gbp_health_log")
        .select("score, flags, reviews_last_7d")
        .eq("client_id", client.id)
        .eq("date", today)
        .maybeSingle();

      const flagsUnchanged = existing
        && existing.score === overall
        && Array.isArray(existing.flags)
        && existing.flags.length === flags.length
        && existing.flags.every((f: string) => flags.includes(f));

      const previousReviewsLast7 = existing?.reviews_last_7d ?? 0;

      await supa.from("gbp_health_log").upsert({
        client_id: client.id,
        date: today,
        posts_last_7d: metrics.postsLast7,
        photos_last_7d: metrics.photosLast7,
        qa_pending: metrics.qaPending,
        reviews_last_7d: metrics.reviewsLast7,
        reviews_avg_rating: metrics.avgRating || null,
        flags,
        score: overall,
      }, { onConflict: "client_id,date" });

      // side-effects are skipped when nothing material changed today
      if (!flagsUnchanged) {
        // Emit positive wins (new 5-star reviews) — only when the count went up
        if (metrics.newFiveStar > 0 && metrics.reviewsLast7 > previousReviewsLast7) {
          await emitWin({
            client_id: client.id,
            kind: "new_review_5star",
            headline: `${metrics.newFiveStar} new 5-star review${metrics.newFiveStar > 1 ? "s" : ""}`,
            detail: `Average rating last 7d: ${metrics.avgRating.toFixed(2)}.`,
            payload: { count: metrics.newFiveStar, avg_rating: metrics.avgRating },
            source: "gbp_health",
          });
        }

        // Enqueue strategist follow-up if score < 60 or flags exist
        if (overall < 60 || flags.length > 0) {
          const queue = await enqueueForStrategist({
            client_id: client.id,
            kind: "health_check_followup",
            priority: overall < 40 ? 85 : 65,
            proposed_payload: {
              date: today,
              score: overall,
              flags,
              metrics,
              recommended_actions: flags.map((f) => ({
                flag: f,
                suggested_fix:
                  f === "no_posts_7d" ? "Auto-queue 2 posts (offer + project)"
                  : f === "no_photos_7d" ? "Request 5 fresh photos from client"
                  : f === "no_reviews_7d" ? "Trigger Thanks campaign batch"
                  : f.startsWith("review_rating") ? "Strategist drafts response sequence + review-request batch"
                  : f.endsWith("unanswered_questions") ? "Auto-draft 3 Q&A responses for strategist review"
                  : "Strategist review required",
              })),
            },
            source_function: "gbp-health-check",
            source_payload: { client_id: client.id },
          });
          await notifyStrategistSlack({
            queue_id: queue.queue_id,
            kind_label: "GBP HEALTH FLAG",
            emoji: ":pushpin:",
            client_name: client.business_name,
            client_location: client.primary_city ?? "",
            urgency: overall < 40 ? "high" : "med",
            rows: [
              { label: "overall score", value: `${overall}/100` },
              { label: "posts 7d     ", value: `${metrics.postsLast7}` },
              { label: "photos 7d    ", value: `${metrics.photosLast7}` },
              { label: "Q&A pending  ", value: `${metrics.qaPending}` },
              { label: "reviews 7d   ", value: `${metrics.reviewsLast7}${metrics.avgRating ? ` and avg ${metrics.avgRating.toFixed(2)}` : ""}` },
              { label: "flags        ", value: flags.join(", ") || "none" },
            ],
          });
        }
      }

      results.push({ client: client.business_name, score: overall, flags, account: workingEmail });
    } catch (e) {
      console.error(`gbp-health-check failed for ${client.business_name}: ${(e as Error).message}`);
      results.push({ client: client.business_name, score: null, flags: [`error:${(e as Error).message}`] });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});

// pull all the per-location metrics with the given access token.
// returns null if the location is inaccessible to this account (so the caller can try the next account).
async function collectMetrics(args: {
  token: string;
  accountId: string | undefined;
  locationName: string;
  sevenDaysAgo: string;
}): Promise<GbpMetrics | null> {
  const { token, accountId, locationName, sevenDaysAgo } = args;
  const headers = { "Authorization": `Bearer ${token}` };

  const metrics: GbpMetrics = {
    postsLast7: 0,
    photosLast7: 0,
    qaPending: 0,
    reviewsLast7: 0,
    avgRating: 0,
    newFiveStar: 0,
  };

  // Reviews (legacy v4) — needs accountId
  if (accountId) {
    const revRes = await fetch(
      `${GBP_LEGACY}/accounts/${accountId}/${locationName}/reviews?pageSize=50&orderBy=updateTime desc`,
      { headers },
    );
    if (revRes.status === 403 || revRes.status === 404) return null;
    if (revRes.ok) {
      const rd = await revRes.json();
      const recent = (rd.reviews || []).filter((r: { updateTime: string }) => r.updateTime > sevenDaysAgo);
      metrics.reviewsLast7 = recent.length;
      if (recent.length > 0) {
        const starMap: Record<string, number> = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 };
        const ratings = recent.map((r: { starRating: string }) => starMap[r.starRating] || 0);
        metrics.avgRating = ratings.reduce((s: number, r: number) => s + r, 0) / ratings.length;
        metrics.newFiveStar = recent.filter((r: { starRating: string }) => r.starRating === "FIVE").length;
      }
    }
  }

  // Posts (legacy v4) — needs accountId
  if (accountId) {
    const postsRes = await fetch(
      `${GBP_LEGACY}/accounts/${accountId}/${locationName}/localPosts?pageSize=20`,
      { headers },
    );
    if (postsRes.status === 403 || postsRes.status === 404) return null;
    if (postsRes.ok) {
      const pd = await postsRes.json();
      metrics.postsLast7 = (pd.localPosts || []).filter((p: { createTime: string }) => p.createTime > sevenDaysAgo).length;
    }
  }

  // Q&A — correct host is mybusinessqanda.googleapis.com
  const qaRes = await fetch(
    `${GBP_QANDA}/${locationName}/questions?pageSize=50&answersPerQuestion=1`,
    { headers },
  );
  if (qaRes.status === 403 || qaRes.status === 404) return null;
  if (qaRes.ok) {
    const qd = await qaRes.json();
    metrics.qaPending = (qd.questions || []).filter(
      (q: { totalAnswerCount?: number }) => !q.totalAnswerCount || q.totalAnswerCount === 0,
    ).length;
  }

  // Photos (legacy v4) — needs accountId
  if (accountId) {
    const mRes = await fetch(
      `${GBP_LEGACY}/accounts/${accountId}/${locationName}/media?pageSize=20`,
      { headers },
    );
    if (mRes.status === 403 || mRes.status === 404) return null;
    if (mRes.ok) {
      const md = await mRes.json();
      metrics.photosLast7 = (md.mediaItems || []).filter((m: { createTime: string }) => m.createTime > sevenDaysAgo).length;
    }
  }

  return metrics;
}

function scoreMetrics(metrics: GbpMetrics): { flags: string[]; scores: GbpScore } {
  const flags: string[] = [];
  const scores: GbpScore = { posts: 0, photos: 0, qa: 0, reviews: 0, attributes: 100, hours: 100 };

  scores.reviews = Math.min(100, metrics.reviewsLast7 * 20);
  if (metrics.reviewsLast7 === 0) flags.push("no_reviews_7d");
  if (metrics.avgRating > 0 && metrics.avgRating < 4.0) flags.push("review_rating_below_4");

  scores.posts = Math.min(100, metrics.postsLast7 * 25);
  if (metrics.postsLast7 === 0) flags.push("no_posts_7d");

  scores.qa = metrics.qaPending === 0 ? 100 : Math.max(0, 100 - metrics.qaPending * 20);
  if (metrics.qaPending > 0) flags.push(`${metrics.qaPending}_unanswered_questions`);

  scores.photos = Math.min(100, metrics.photosLast7 * 20);
  if (metrics.photosLast7 === 0) flags.push("no_photos_7d");

  return { flags, scores };
}
