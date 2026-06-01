// Daily cron health monitor — runs at 06:00 UTC.
// Sweeps cron.job_run_details over the last 24h, groups by jobname,
// flags failures and stale jobs, and pings the strategist channel.
//
// Auth gate: requires CRON_SECRET in the Authorization header OR the
// Supabase service-role bearer. Browser-callable OPTIONS is supported
// for completeness but not expected in normal cron operation.
//
// REQUIRED MIGRATION (ship alongside as e.g. 107_cron_health_function.sql):
//
//   create or replace function public.get_cron_health_24h()
//   returns table (
//     jobname text,
//     status text,
//     return_message text,
//     start_time timestamptz,
//     end_time timestamptz
//   )
//   language sql
//   security definer
//   set search_path = cron, public
//   as $$
//     select j.jobname,
//            jr.status,
//            jr.return_message,
//            jr.start_time,
//            jr.end_time
//     from cron.job_run_details jr
//     join cron.job j on j.jobid = jr.jobid
//     where jr.start_time > now() - interval '24 hours'
//     order by jr.start_time desc;
//   $$;
//
//   revoke all on function public.get_cron_health_24h() from public;
//   grant execute on function public.get_cron_health_24h() to service_role;
//
// cron.job_run_details has jobid (NOT jobname), so we join cron.job on jobid
// to recover the human-readable name.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { notifyStrategistSlack } from "../_shared/strategist-queue.ts";

interface RunRow {
  jobname: string;
  status: string;
  return_message: string | null;
  start_time: string;
  end_time: string | null;
}

interface JobSummary {
  jobname: string;
  success_count: number;
  failure_count: number;
  last_run: string | null;
  last_status: string | null;
  last_error: string | null;
}

// jobs we expect to run at least daily. Anything in here whose last_run is
// older than 26h gets flagged as stale. Add new daily jobs as they ship.
const DAILY_JOBS = new Set<string>([
  "rank-tracking-cron",
  "gsc-ga4-sync",
  "gbp-health-check",
  "ai-visibility-probe",
  "competitor-watchdog",
  "citation-nap-sync",
]);

const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000;

function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const cronSecret = Deno.env.get("CRON_SECRET");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (cronSecret && bearer === cronSecret) return true;
  if (serviceKey && bearer === serviceKey) return true;
  return false;
}

serve(async (req) => {
  // CORS preflight (optional — function is cron-only in practice).
  const pre = handleCors(req);
  if (pre) return pre;

  const corsHeaders = {
    ...getCorsHeaders(req),
    "Content-Type": "application/json",
  };

  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // pull last 24h via RPC since cron.* isn't exposed through PostgREST
  const { data: rows, error } = await supa.rpc("get_cron_health_24h");
  if (error) {
    console.error("get_cron_health_24h rpc failed:", error.message);
    return new Response(
      JSON.stringify({ error: `rpc failed: ${error.message}` }),
      { status: 500, headers: corsHeaders },
    );
  }

  const runs: RunRow[] = Array.isArray(rows) ? rows : [];

  // group by jobname
  const byJob = new Map<string, JobSummary>();
  for (const r of runs) {
    if (!r.jobname) continue;
    const s = byJob.get(r.jobname) || {
      jobname: r.jobname,
      success_count: 0,
      failure_count: 0,
      last_run: null,
      last_status: null,
      last_error: null,
    };
    const succeeded = r.status === "succeeded";
    if (succeeded) s.success_count += 1;
    else s.failure_count += 1;

    // runs are ordered desc by start_time, so the first hit wins as last_run
    if (!s.last_run) {
      s.last_run = r.start_time;
      s.last_status = r.status;
      s.last_error = succeeded ? null : (r.return_message || null);
    }
    byJob.set(r.jobname, s);
  }

  const summaries = Array.from(byJob.values());
  const now = Date.now();

  const failing: JobSummary[] = summaries.filter((s) => s.failure_count > 0);

  // stale = job we expect daily that either never ran in 24h or last_run is older than threshold
  const stale: Array<{ jobname: string; last_run: string | null; reason: string }> = [];
  for (const jobname of DAILY_JOBS) {
    const s = byJob.get(jobname);
    if (!s || !s.last_run) {
      stale.push({ jobname, last_run: null, reason: "no runs in last 24h" });
      continue;
    }
    const ageMs = now - new Date(s.last_run).getTime();
    if (ageMs > STALE_THRESHOLD_MS) {
      stale.push({
        jobname,
        last_run: s.last_run,
        reason: `last run ${Math.round(ageMs / 3600000)}h ago`,
      });
    }
  }

  // fire slack alerts as fire-and-forget so the http response isn't blocked by slack
  const alertWork = (async () => {
    for (const f of failing) {
      try {
        await notifyStrategistSlack({
          queue_id: `cron-fail-${f.jobname}-${new Date().toISOString().slice(0, 10)}`,
          kind_label: "CRON FAILURE",
          emoji: ":rotating_light:",
          client_name: f.jobname,
          urgency: "high",
          rows: [
            { label: "failures", value: String(f.failure_count) },
            { label: "successes", value: String(f.success_count) },
            { label: "last_run", value: f.last_run || "n/a" },
            { label: "last_status", value: f.last_status || "n/a" },
            { label: "last_error", value: (f.last_error || "").slice(0, 200) || "n/a" },
          ],
          preview: f.last_error ? f.last_error.slice(0, 800) : undefined,
          cta_label: "Open Supabase logs",
        });
      } catch (e) {
        console.error("slack failure alert errored:", (e as Error).message);
      }
    }

    for (const s of stale) {
      try {
        await notifyStrategistSlack({
          queue_id: `cron-stale-${s.jobname}-${new Date().toISOString().slice(0, 10)}`,
          kind_label: "CRON STALE",
          emoji: ":hourglass_flowing_sand:",
          client_name: s.jobname,
          urgency: "med",
          rows: [
            { label: "last_run", value: s.last_run || "never (24h)" },
            { label: "reason", value: s.reason },
          ],
          cta_label: "Open Supabase cron",
        });
      } catch (e) {
        console.error("slack stale alert errored:", (e as Error).message);
      }
    }
  })();

  // @ts-ignore EdgeRuntime is provided by the Supabase Deno runtime
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(alertWork);
  } else {
    // local dev fallback — keep errors from leaking
    await Promise.allSettled([alertWork]);
  }

  const payload = {
    ok: true,
    jobs_checked: summaries.length,
    healthy: summaries.filter((s) => s.failure_count === 0).length,
    failing: failing.length,
    missed_count: stale.length,
    failing_jobs: failing.map((f) => ({
      jobname: f.jobname,
      failure_count: f.failure_count,
      last_error: f.last_error,
      last_run: f.last_run,
    })),
    stale_jobs: stale,
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: corsHeaders,
  });
});
