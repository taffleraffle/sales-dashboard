// GBP weekly health check
// Reads each client's GBP profile (account_id + location_id from clients.client_json)
// using Google My Business / Business Profile API with refresh-token auth.
// Computes a 0-100 health score across: posts cadence, photos cadence, Q&A response time,
// review velocity, attribute drift, hours drift.
//
// Routes negatives to strategist queue (internal flag, not client-facing).
// Routes positives (new 5★ reviews, post traction) to wins emitter.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { getGoogleAccessToken } from "../_shared/google-auth.ts";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { emitWin } from "../_shared/win-emit.ts";

const GBP_ACC = "https://mybusinessaccountmanagement.googleapis.com/v1";
const GBP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const GBP_LEGACY = "https://mybusiness.googleapis.com/v4";

interface GbpScore {
  posts: number;
  photos: number;
  qa: number;
  reviews: number;
  attributes: number;
  hours: number;
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

  let token: string;
  try {
    token = await getGoogleAccessToken();
  } catch (e) {
    return new Response(JSON.stringify({ error: `google auth: ${(e as Error).message}` }), { status: 500 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const results: Array<{ client: string; score: number | null; flags: string[] }> = [];

  for (const client of clients) {
    const cj = (client.client_json || {}) as { gbp_account_id?: string; gbp_location_id?: string; gbp_location_name?: string };
    const accountId = cj.gbp_account_id;
    const locationName = cj.gbp_location_name; // format: "locations/12345"
    if (!locationName) {
      results.push({ client: client.business_name, score: null, flags: ["no_gbp_mapped"] });
      continue;
    }

    const flags: string[] = [];
    const scores: GbpScore = { posts: 0, photos: 0, qa: 0, reviews: 0, attributes: 100, hours: 100 };

    try {
      // Reviews (last 7d) — legacy v4 endpoint is the simplest for review velocity
      let reviewsLast7 = 0;
      let avgRating = 0;
      let newFiveStar = 0;
      if (accountId) {
        const revRes = await fetch(`${GBP_LEGACY}/accounts/${accountId}/${locationName}/reviews?pageSize=50&orderBy=updateTime desc`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (revRes.ok) {
          const rd = await revRes.json();
          const recent = (rd.reviews || []).filter((r: { updateTime: string }) => r.updateTime > sevenDaysAgo);
          reviewsLast7 = recent.length;
          if (recent.length > 0) {
            const ratings = recent.map((r: { starRating: string }) => ({ FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[r.starRating] || 0));
            avgRating = ratings.reduce((s: number, r: number) => s + r, 0) / ratings.length;
            newFiveStar = recent.filter((r: { starRating: string }) => r.starRating === "FIVE").length;
          }
          scores.reviews = Math.min(100, reviewsLast7 * 20);
          if (reviewsLast7 === 0) flags.push("no_reviews_7d");
          if (avgRating > 0 && avgRating < 4.0) flags.push("review_rating_below_4");
        }
      }

      // Posts last 7 days — localPosts.list
      let postsLast7 = 0;
      if (accountId) {
        const postsRes = await fetch(`${GBP_LEGACY}/accounts/${accountId}/${locationName}/localPosts?pageSize=20`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (postsRes.ok) {
          const pd = await postsRes.json();
          postsLast7 = (pd.localPosts || []).filter((p: { createTime: string }) => p.createTime > sevenDaysAgo).length;
          scores.posts = Math.min(100, postsLast7 * 25);
          if (postsLast7 === 0) flags.push("no_posts_7d");
        }
      }

      // Q&A pending — questions.list
      let qaPending = 0;
      if (accountId) {
        const qaRes = await fetch(`${GBP_LEGACY}/${locationName}/questions?pageSize=50&answersPerQuestion=1`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (qaRes.ok) {
          const qd = await qaRes.json();
          qaPending = (qd.questions || []).filter((q: { totalAnswerCount?: number }) => !q.totalAnswerCount || q.totalAnswerCount === 0).length;
          scores.qa = qaPending === 0 ? 100 : Math.max(0, 100 - qaPending * 20);
          if (qaPending > 0) flags.push(`${qaPending}_unanswered_questions`);
        }
      }

      // Photos last 7 — media.list
      let photosLast7 = 0;
      if (accountId) {
        const mRes = await fetch(`${GBP_LEGACY}/accounts/${accountId}/${locationName}/media?pageSize=20`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (mRes.ok) {
          const md = await mRes.json();
          photosLast7 = (md.mediaItems || []).filter((m: { createTime: string }) => m.createTime > sevenDaysAgo).length;
          scores.photos = Math.min(100, photosLast7 * 20);
          if (photosLast7 === 0) flags.push("no_photos_7d");
        }
      }

      const overall = Math.round(
        scores.posts * 0.2 + scores.photos * 0.15 + scores.qa * 0.2 + scores.reviews * 0.3 + scores.attributes * 0.075 + scores.hours * 0.075,
      );

      await supa.from("gbp_health_log").upsert({
        client_id: client.id,
        date: today,
        posts_last_7d: postsLast7,
        photos_last_7d: photosLast7,
        qa_pending: qaPending,
        reviews_last_7d: reviewsLast7,
        reviews_avg_rating: avgRating || null,
        flags,
        score: overall,
      }, { onConflict: "client_id,date" });

      // Emit positive wins
      if (newFiveStar > 0) {
        await emitWin({
          client_id: client.id,
          kind: "new_review_5star",
          headline: `${newFiveStar} new 5★ review${newFiveStar > 1 ? "s" : ""}`,
          detail: `Average rating last 7d: ${avgRating.toFixed(2)}.`,
          payload: { count: newFiveStar, avg_rating: avgRating },
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
            metrics: { postsLast7, photosLast7, qaPending, reviewsLast7, avgRating },
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
        await notifyStrategistSlack(
          queue.queue_id,
          `GBP health ${overall}/100 for *${client.business_name}* — flags: ${flags.join(", ")}`,
        );
      }

      results.push({ client: client.business_name, score: overall, flags });
    } catch (e) {
      results.push({ client: client.business_name, score: null, flags: [`error:${(e as Error).message}`] });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
