// onboarding-automation — one-shot client provisioning for ROM HQ.
//
// Trigger: POST {
//   client_slug?, business_name, vertical, primary_city, state_abbr,
//   custom_domain, owners[], competitors[], tracked_keywords[],
//   gbp_oauth_account?
// }
//
// Pipeline (sequential, then fire-and-forget):
//   1. validate input (vertical against CHECK constraint, required fields)
//   2. insert clients row (status=onboarding, idempotent via unique slug)
//   3. insert tracked_keywords with default search_location
//   4. insert owners into client_stakeholders (not buried in client_json)
//   5. fire-and-forget via EdgeRuntime.waitUntil:
//      roadmap-generator, content-brief-generator x top2 kws,
//      rank-tracking-cron, ai-visibility-probe
//   6. one rollup Slack post to #strategy-queue
//   7. return { client_id, slug, jobs_fired, next_steps }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost } from "../_shared/slack.ts";

// boot-time env guard — fail loudly if anything required is missing
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_STRATEGY",
];
for (const k of REQUIRED_ENV) {
  if (!Deno.env.get(k)) {
    console.error(`[onboarding-automation] missing required env: ${k}`);
  }
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_CHANNEL_STRATEGY = Deno.env.get("SLACK_CHANNEL_STRATEGY")!;
const ROM_AGENCY_ID = Deno.env.get("ROM_AGENCY_ID") || null;
const DEFAULT_GBP_OAUTH = "hello@rankonmaps.io";

// allowed values from clients.vertical CHECK constraint (migration 100)
const ALLOWED_VERTICALS = [
  "roofing",
  "hvac",
  "plumbing",
  "landscaping",
  "dental",
  "legal",
  "restoration",
  "other",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OwnerInput {
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
  is_primary?: boolean;
  decision_authority?: string;
  notes?: string;
}

interface OnboardingInput {
  client_slug?: string;
  business_name: string;
  vertical: string;
  primary_city: string;
  state_abbr: string;
  custom_domain?: string;
  owners?: OwnerInput[];
  competitors?: string[];
  tracked_keywords?: string[];
  gbp_oauth_account?: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

// fire-and-forget: invoke another edge function and log non-ok responses.
// caller must wrap in EdgeRuntime.waitUntil so the isolate stays alive.
function fireJob(name: string, payload: Record<string, unknown>): Promise<void> {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then((r) => {
      if (!r.ok) console.log(`[onboarding-automation] ${name} returned ${r.status}`);
    })
    .catch((e) => {
      console.log(`[onboarding-automation] ${name} fetch failed:`, String(e));
    });
}

// schedule a background promise so the response can return without killing it.
// falls back to Promise.allSettled accumulation for local dev when EdgeRuntime is absent.
const pendingFallback: Promise<unknown>[] = [];
function scheduleBackground(p: Promise<unknown>): void {
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") {
    er.waitUntil(p);
  } else {
    pendingFallback.push(p);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  let input: OnboardingInput;
  try {
    input = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  if (!input.business_name || !input.vertical || !input.primary_city || !input.state_abbr) {
    return json({
      error: "missing required fields: business_name, vertical, primary_city, state_abbr",
    }, 400);
  }

  // validate vertical up front against the CHECK constraint
  const verticalLower = String(input.vertical).toLowerCase().trim();
  if (!ALLOWED_VERTICALS.includes(verticalLower)) {
    return json({
      error: "invalid_vertical",
      message: `vertical must be one of: ${ALLOWED_VERTICALS.join(", ")}`,
      received: input.vertical,
    }, 400);
  }

  // normalize state to 2-letter upper if it looks 2-char
  const stateAbbr = String(input.state_abbr).trim().toUpperCase().slice(0, 8);

  const slug = slugify(input.client_slug || input.business_name);
  if (!slug) return json({ error: "could not derive slug" }, 400);

  const owners = Array.isArray(input.owners) ? input.owners : [];
  const competitors = Array.isArray(input.competitors) ? input.competitors : [];
  const trackedKeywords = Array.isArray(input.tracked_keywords) ? input.tracked_keywords : [];
  const gbpAccount = input.gbp_oauth_account || DEFAULT_GBP_OAUTH;
  const searchLocation = `${input.primary_city},${stateAbbr},United States`;

  // step 2: insert clients row. rely on unique(slug) for idempotency; handle 23505.
  // we keep competitors + gbp account inside client_json since there are no
  // dedicated columns for them, but agency_id and state_abbr go to real columns.
  const clientJson = {
    competitors,
    gbp_oauth_account: gbpAccount,
    onboarded_at: new Date().toISOString(),
  };

  const insertPayload: Record<string, unknown> = {
    slug,
    business_name: input.business_name,
    vertical: verticalLower,
    primary_city: input.primary_city,
    state_abbr: stateAbbr,
    status: "onboarding",
    custom_domain: input.custom_domain || null,
    client_json: clientJson,
  };
  if (ROM_AGENCY_ID) insertPayload.agency_id = ROM_AGENCY_ID;

  const { data: newClient, error: insertErr } = await supa
    .from("clients")
    .insert(insertPayload)
    .select("id, slug, business_name")
    .single();

  if (insertErr || !newClient) {
    // 23505 = unique_violation on slug → return 409 with the existing row
    const code = (insertErr as { code?: string } | null)?.code;
    if (code === "23505") {
      const { data: existing } = await supa
        .from("clients")
        .select("id, slug, business_name, status")
        .eq("slug", slug)
        .maybeSingle();
      return json({
        error: "slug_exists",
        message: `client with slug '${slug}' already exists`,
        existing_client_id: existing?.id ?? null,
      }, 409);
    }
    return json({ error: "insert_failed", detail: insertErr?.message }, 500);
  }

  const clientId: string = newClient.id;

  // step 3: tracked_keywords
  let keywordsInserted = 0;
  if (trackedKeywords.length > 0) {
    const rows = trackedKeywords
      .filter((k) => typeof k === "string" && k.trim().length > 0)
      .map((k) => ({
        client_id: clientId,
        keyword: k.trim(),
        search_location: searchLocation,
      }));
    if (rows.length > 0) {
      const { error: kwErr, count } = await supa
        .from("tracked_keywords")
        .insert(rows, { count: "exact" });
      if (kwErr) {
        console.log("[onboarding-automation] tracked_keywords insert error:", kwErr.message);
      } else {
        keywordsInserted = count ?? rows.length;
      }
    }
  }

  // step 4: insert owners into client_stakeholders (real table, not client_json).
  // first owner with is_primary=true (or first overall) becomes primary.
  let stakeholdersInserted = 0;
  if (owners.length > 0) {
    const ALLOWED_ROLES = new Set(["owner", "office_manager", "marketing_lead", "technical_contact", "billing_contact", "other"]);
    const cleaned = owners
      .filter((o) => o && (o.name || o.email || o.phone))
      .map((o) => ({
        name: (o.name || o.email || "Unknown").trim(),
        role: o.role && ALLOWED_ROLES.has(o.role) ? o.role : "owner",
        email: o.email || null,
        phone: o.phone || null,
        decision_authority: o.decision_authority || null,
        notes: o.notes || null,
        is_primary: o.is_primary === true,
      }));
    // if nobody flagged primary, mark the first one
    if (cleaned.length > 0 && !cleaned.some((o) => o.is_primary)) {
      cleaned[0].is_primary = true;
    }
    const stakeholderRows = cleaned.map((o) => ({ client_id: clientId, ...o }));
    if (stakeholderRows.length > 0) {
      const { error: shErr, count } = await supa
        .from("client_stakeholders")
        .insert(stakeholderRows, { count: "exact" });
      if (shErr) {
        console.log("[onboarding-automation] stakeholders insert error:", shErr.message);
      } else {
        stakeholdersInserted = count ?? stakeholderRows.length;
      }
    }
  }

  // step 5: pick top 2 money keywords for content brief generation.
  // heuristic: take first 2 supplied keywords; client can reorder later.
  const moneyKeywords = trackedKeywords
    .filter((k) => typeof k === "string" && k.trim().length > 0)
    .slice(0, 2);

  // step 6: fire-and-forget background jobs, kept alive by EdgeRuntime.waitUntil
  const jobs: string[] = [];

  scheduleBackground(fireJob("roadmap-generator", { client_id: clientId }));
  jobs.push("roadmap-generator");

  for (const kw of moneyKeywords) {
    scheduleBackground(fireJob("content-brief-generator", {
      client_id: clientId,
      target_keyword: kw,
    }));
    jobs.push(`content-brief-generator(${kw})`);
  }

  scheduleBackground(fireJob("rank-tracking-cron", { client_id: clientId }));
  jobs.push("rank-tracking-cron");

  scheduleBackground(fireJob("ai-visibility-probe", { client_id: clientId }));
  jobs.push("ai-visibility-probe");

  // step 7: rollup notification to #strategy-queue
  const headline = `New client onboarded: ${input.business_name} · ${input.primary_city} · ${verticalLower} · ${jobs.length} background jobs fired`;
  try {
    const slackResult = await slackPost(
      SLACK_CHANNEL_STRATEGY,
      [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${headline}*` },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `slug: \`${slug}\` · keywords: ${keywordsInserted} · stakeholders: ${stakeholdersInserted} · gbp: ${gbpAccount}`,
            },
          ],
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `jobs: ${jobs.join(", ")}` },
          ],
        },
      ],
      headline,
    );
    if (slackResult && slackResult.ok === false) {
      console.log("[onboarding-automation] slack post not ok:", slackResult.error);
    }
  } catch (e) {
    console.log("[onboarding-automation] slack post failed:", String(e));
  }

  // if EdgeRuntime not available (local dev), make sure pending fetches resolve
  // deno-lint-ignore no-explicit-any
  if (!(globalThis as any).EdgeRuntime && pendingFallback.length > 0) {
    await Promise.allSettled(pendingFallback.splice(0));
  }

  // step 8: return summary
  return json({
    client_id: clientId,
    slug,
    jobs_fired: jobs,
    keywords_inserted: keywordsInserted,
    stakeholders_inserted: stakeholdersInserted,
    gbp_oauth_account: gbpAccount,
    next_steps: [
      "strategist reviews roadmap once roadmap-generator completes",
      "strategist approves content briefs in queue",
      "baseline ranks land within ~5 min via rank-tracking-cron",
      "ai-visibility baseline lands within ~5 min via ai-visibility-probe",
      "kickoff call scheduled by AM tandem (Jonathan + Mersad)",
    ],
  });
});
