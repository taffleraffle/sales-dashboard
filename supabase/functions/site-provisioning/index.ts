// site-provisioning — end-to-end automation of a new client site.
//
// Trigger: HTTP POST {
//   client_id, fathom_recording_id?, fathom_url?, extra_context?,
//   domain_apex?, cloudflare_project_name?, dry_run?
// }
//
// Pipeline (each step gates the next, errors persist to site_provisioning_runs.error_message):
//   1. load client row
//   2. fetch fathom transcript if recording id/url provided
//   3. build extraction input (transcript + extra_context + client_json)
//   4. anthropic claude-opus-4-7 -> 3 json files (client.json, services.json, areas.json)
//   5. persist run row
//   6. dry_run? return the json
//   7. github: POST /repos/RankOnMaps/rom-site-template/generate -> new private repo
//   8. github: PUT data/client.json, data/services.json, data/areas.json
//   9. cloudflare pages auto-deploys via the template's github action
//  10. enqueue strategist review (mersad)
//  11. emit milestone win
//
// no fabricated client specifics. anything inferred gets _inferred: true.

import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.32";
import { emitWin } from "../_shared/win-emit.ts";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const FATHOM_API_KEY = Deno.env.get("FATHOM_API_KEY") || "";
const GH_TOKEN = Deno.env.get("GH_TOKEN") || "";

const GH_OWNER = "RankOnMaps";
const GH_TEMPLATE_REPO = "rom-site-template";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ──────────────────────────────────────────────────────────────────────────────
// helpers

function slugify(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function indexNowKey(): string {
  // 32-char hex, no dashes
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchFathomTranscript(opts: {
  recording_id?: string;
  url?: string;
}): Promise<{ transcript: string; recording_id?: string } | null> {
  if (!FATHOM_API_KEY) return null;

  let recording_id = opts.recording_id;

  // resolve url -> recording_id
  if (!recording_id && opts.url) {
    const res = await fetch(
      `https://api.fathom.video/v1/recordings/by-url?url=${encodeURIComponent(opts.url)}`,
      { headers: { "X-Api-Key": FATHOM_API_KEY } },
    );
    if (res.ok) {
      const j = await res.json();
      recording_id = j?.recording_id || j?.id;
    } else {
      throw new Error(`fathom by-url failed: ${res.status} ${await res.text()}`);
    }
  }

  if (!recording_id) return null;

  const res = await fetch(
    `https://api.fathom.video/v1/recordings/${recording_id}/transcript`,
    { headers: { "X-Api-Key": FATHOM_API_KEY } },
  );
  if (!res.ok) {
    throw new Error(`fathom transcript failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const transcript = typeof data === "string"
    ? data
    : data?.transcript || data?.text || JSON.stringify(data);
  return { transcript, recording_id };
}

// system prompt mirrors /tmp/rom-site-template/docs/transcript-to-client-json.md
function buildExtractionSystemPrompt(): string {
  return `You are extracting structured data from a Fathom onboarding-call transcript (plus any extra notes provided) for a new Rank On Maps client. Your output is committed verbatim to a static-site repo and rendered into a marketing website.

Read the input I share next and produce three JSON files. Wrap each in a separate \`\`\`json code block where the FIRST LINE inside the block is a comment naming the file, exactly like:
\`\`\`json
// data/client.json
{ ... }
\`\`\`

### Output 1 — data/client.json
Follow this schema exactly. Every field is required unless marked optional. Use sensible inferred values where the input is silent, but flag inferred blocks with "_inferred": true at the relevant block level. Never fabricate addresses, license numbers, founder names, named testimonials, or pricing. Use "[TBC]" if a value isn't in the input.

{
  "brand": {
    "name": "<full business name>",
    "name_short": "<short version for nav>",
    "parent_name": "<parent company or DBA, or empty string>",
    "tagline": "<one-line positioning, ~6-10 words>",
    "vertical": "<roofing|hvac|plumbing|landscaping|dental|legal|photography|other>",
    "vertical_label_singular": "<Roofer|Plumber|etc>",
    "vertical_label_plural": "<Roofers|Plumbers|etc>"
  },
  "site": {
    "url": "<https://primarydomain.com>",
    "domain_apex": "<primarydomain.com>",
    "cloudflare_project_name": "<lowercase-with-dashes slug>"
  },
  "contact": {
    "phone": "<555-555-5555>",
    "phone_display": "<(555) 555-5555>",
    "email": "<contact email>",
    "address": {"street":"...","city":"...","state":"...","zip":"...","country":"US"},
    "geo": {"lat":0,"lng":0},
    "hours": {"mon":"07:00-18:00","tue":"...","wed":"...","thu":"...","fri":"...","sat":"...","sun":"closed"},
    "quote_url": "<external instant-quote URL, or empty string>"
  },
  "market": {
    "primary_city": "<main city served>",
    "region": "<regional descriptor>",
    "region_descriptor": "<sub-region>",
    "state_long": "<Texas>",
    "state_abbr": "<TX>",
    "metro_label": "<Austin Metro>",
    "service_radius_miles": 75,
    "primary_counties": ["County A","County B"],
    "signature_neighborhoods": ["Suburb 1","Suburb 2","Suburb 3"]
  },
  "stats": {
    "years_in_business": 0,
    "jobs_completed": "<5,000+>",
    "review_rating": 5,
    "review_count": "<count as string>",
    "founded_year_text": "<e.g. 1998>"
  },
  "founder": {
    "name": "<first name>",
    "first_name": "<same>",
    "title": "<Master Plumber · Founder>",
    "years_experience": 0,
    "bio_short": "<60-80 words, direct-answer voice>",
    "bio_long": "<150-220 words>",
    "signature_skills": ["Skill 1","Skill 2","Skill 3","Skill 4","Skill 5","Skill 6"]
  },
  "second_founder": {
    "name": "<full name or empty>",
    "first_name": "<first only>",
    "title": "<Co-Founder · Operations>",
    "bio_short": "<40-60 words>",
    "background": "<one sentence>"
  },
  "company_story": {
    "headline": "<one-line story tagline>",
    "narrative": "<80-120 words on the founding story>",
    "family_of_companies": [{"name":"...","role":"...","url":"..."}]
  },
  "certifications": [
    {"name": "<Cert name>", "tier": "<premium|trust>", "note": "<one-line note>"}
  ],
  "signature_specialties": [
    {"name":"<Specialty headline>","summary":"<40-60 word summary>","anchor":"<kebab-case-anchor>"}
  ],
  "social": {
    "google": "<https://maps.google.com/?cid=... or [TBC]>",
    "facebook": "<https://facebook.com/... or empty>",
    "instagram": "<https://instagram.com/... or empty>"
  },
  "links": {
    "bbb_profile": "<full BBB profile URL or empty>",
    "bbb_seal_image": "<BBB seal image URL or empty>"
  },
  "tracking": {
    "ga4_measurement_id": "",
    "wc_account_id": "",
    "wc_profile_id": "",
    "wc_tracker_host": "",
    "indexnow_key": "<32-char hex string — will be set by the server>",
    "_note": "Tracking IDs are wired in during the tracking-setup phase."
  },
  "deploy": {
    "cloudflare_account_id_secret": "CLOUDFLARE_ACCOUNT_ID",
    "cloudflare_api_token_secret": "CLOUDFLARE_API_TOKEN"
  },
  "service_areas_summary": "<one sentence summarizing the service area>"
}

### Output 2 — data/services.json
A JSON array of 5-10 service objects. Each object must have at least: slug, name, h1, description, faqs (array of {q,a}). Add additional fields where the vertical calls for them.

### Output 3 — data/areas.json
A JSON array of 3-8 service-area objects (one per city). Each needs: slug, name, county, zip_primary, h1, card_summary, search_volume (integer estimate), tier (1|2|3), lat, lng, landmarks (array), neighborhoods (array), climate_note, intro_paragraphs (array of 2-3 paragraphs), what_we_do_locally, faqs (array of 4-6 {q,a} pairs).

### Voice rules
- No em-dashes. Use commas, semicolons, or new sentences.
- No AI flourishes. No "moreover," "furthermore," "elevate your," "unlock the power of."
- Direct-answer voice. 40-60 word paragraphs that answer the question in the first sentence.
- Specific not vague.
- No fabricated specifics. Use "[TBC]" if the input doesn't say.
- Trade-specific vocabulary. Preserve technical depth from the transcript.

After the three code blocks, append a final code block:
\`\`\`json
// extraction-notes.json
{ "notes": "<one paragraph for Mersad: what was confident, what was inferred, what needs follow-up>" }
\`\`\`

Output the four code blocks back-to-back, nothing else.`;
}

interface ExtractionResult {
  client_json: Record<string, unknown>;
  services_json: unknown[];
  areas_json: unknown[];
  extraction_notes: string;
}

function parseExtraction(text: string): ExtractionResult {
  // grab all ```json ... ``` blocks
  const re = /```json\s*([\s\S]+?)\s*```/g;
  const blocks: Array<{ filename: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim();
    const firstLine = body.split("\n")[0].trim();
    const fnMatch = firstLine.match(/^\/\/\s*(.+)$/);
    const filename = fnMatch ? fnMatch[1].trim() : "";
    const jsonBody = fnMatch ? body.replace(/^\/\/.*\n/, "") : body;
    blocks.push({ filename, body: jsonBody });
  }

  if (blocks.length < 3) {
    throw new Error(`extraction returned ${blocks.length} json blocks, expected 3-4`);
  }

  const pick = (name: string) =>
    blocks.find((b) => b.filename.toLowerCase().includes(name.toLowerCase()));

  const clientBlock = pick("client.json") || blocks[0];
  const servicesBlock = pick("services.json") || blocks[1];
  const areasBlock = pick("areas.json") || blocks[2];
  const notesBlock = pick("extraction-notes.json");

  const client_json = JSON.parse(clientBlock.body);
  const services_json = JSON.parse(servicesBlock.body);
  const areas_json = JSON.parse(areasBlock.body);
  let extraction_notes = "";
  if (notesBlock) {
    try {
      const n = JSON.parse(notesBlock.body);
      extraction_notes = n?.notes || "";
    } catch { /* ignore */ }
  }

  return { client_json, services_json, areas_json, extraction_notes };
}

// ──────────────────────────────────────────────────────────────────────────────
// github

async function ghFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!GH_TOKEN) throw new Error("GH_TOKEN env var not set");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${GH_TOKEN}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "rankonmaps-site-provisioning");
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

async function generateRepoFromTemplate(repoName: string): Promise<{ repo_name: string; repo_url: string }> {
  const res = await ghFetch(
    `/repos/${GH_OWNER}/${GH_TEMPLATE_REPO}/generate`,
    {
      method: "POST",
      body: JSON.stringify({
        owner: GH_OWNER,
        name: repoName,
        description: `Rank On Maps client site · ${repoName}`,
        include_all_branches: false,
        private: true,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`github generate failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { repo_name: data.name, repo_url: data.html_url };
}

// RankOnMaps is a USER not an org, so org-level secrets aren't available.
// Each newly generated repo needs Cloudflare secrets copied from env so its
// existing GitHub Actions deploy workflow can authenticate.
async function copySecretsToNewRepo(repoName: string): Promise<{ ok: boolean; detail?: string }> {
  const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!cfToken || !cfAccount) {
    return { ok: false, detail: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing in env" };
  }

  // Fetch repo public key for secret encryption
  const keyRes = await ghFetch(`/repos/${GH_OWNER}/${repoName}/actions/secrets/public-key`);
  if (!keyRes.ok) {
    return { ok: false, detail: `public-key fetch failed: ${keyRes.status}` };
  }
  const { key, key_id } = await keyRes.json();

  // Encrypt + PUT each secret
  // Uses libsodium-wrappers via esm.sh — required for GitHub's sealed_box encryption
  // deno-lint-ignore no-explicit-any
  const sodium = (await import("https://esm.sh/libsodium-wrappers@0.7.13")) as any;
  await sodium.ready;

  async function putSecret(name: string, value: string): Promise<boolean> {
    const keyBytes = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
    const valueBytes = sodium.from_string(value);
    const encrypted = sodium.crypto_box_seal(valueBytes, keyBytes);
    const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
    const r = await ghFetch(`/repos/${GH_OWNER}/${repoName}/actions/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id }),
    });
    return r.ok;
  }

  const tokenOk = await putSecret("CLOUDFLARE_API_TOKEN", cfToken);
  const accountOk = await putSecret("CLOUDFLARE_ACCOUNT_ID", cfAccount);
  return { ok: tokenOk && accountOk, detail: `token=${tokenOk} account=${accountOk}` };
}

function b64encode(s: string): string {
  // deno has btoa, but needs proper utf8 handling
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function commitFile(
  repoName: string,
  path: string,
  contents: string,
  message: string,
): Promise<void> {
  // template generation is async on github's side. retry briefly until repo exists.
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await ghFetch(
      `/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: b64encode(contents),
        }),
      },
    );
    if (res.ok || res.status === 201) return;
    lastErr = `${res.status} ${await res.text()}`;
    if (res.status === 404 || res.status === 409) {
      // repo not ready or file exists race; wait and retry
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 422) {
      // file exists - need sha to overwrite
      const getRes = await ghFetch(
        `/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`,
      );
      if (getRes.ok) {
        const existing = await getRes.json();
        const overwriteRes = await ghFetch(
          `/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              message,
              content: b64encode(contents),
              sha: existing.sha,
            }),
          },
        );
        if (overwriteRes.ok) return;
        lastErr = `${overwriteRes.status} ${await overwriteRes.text()}`;
      }
    }
    throw new Error(`commit ${path} failed: ${lastErr}`);
  }
  throw new Error(`commit ${path} failed after retries: ${lastErr}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// main handler

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  let runId: string | null = null;

  try {
    const body = await req.json();
    const {
      client_id,
      fathom_recording_id,
      fathom_url,
      extra_context,
      domain_apex,
      cloudflare_project_name,
      dry_run,
    } = body || {};

    if (!client_id) {
      return new Response(JSON.stringify({ error: "client_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // step 1: load client
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id, business_name, vertical, primary_city, custom_domain, client_json")
      .eq("id", client_id)
      .maybeSingle();

    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: "client not found", detail: clientErr?.message }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // create the run row up front so errors can attach to it
    const { data: runRow, error: runInsertErr } = await supabase
      .from("site_provisioning_runs")
      .insert({
        client_id,
        status: "failed", // updated as we progress
        fathom_recording_id: fathom_recording_id || null,
        error_message: "in progress",
      })
      .select("id")
      .single();
    if (runInsertErr) throw new Error(`run insert failed: ${runInsertErr.message}`);
    runId = runRow.id;

    // step 2: fathom transcript
    let transcript = "";
    let resolvedRecordingId = fathom_recording_id || "";
    if (fathom_recording_id || fathom_url) {
      const ft = await fetchFathomTranscript({
        recording_id: fathom_recording_id,
        url: fathom_url,
      });
      if (ft) {
        transcript = ft.transcript;
        resolvedRecordingId = ft.recording_id || resolvedRecordingId;
      }
    }

    // step 3: build extraction input
    const existingClientJson = client.client_json ? JSON.stringify(client.client_json, null, 2) : "(none)";
    const userInput = `# Business name (draft)
${client.business_name || "[TBC]"}

# Vertical (draft)
${client.vertical || "[TBC]"}

# Primary city (draft)
${client.primary_city || "[TBC]"}

# Custom domain (draft)
${client.custom_domain || domain_apex || "[TBC]"}

# Existing client_json (may be partial or empty)
${existingClientJson}

# Fathom transcript
${transcript || "(no transcript provided)"}

# Extra context / pasted notes / emails
${extra_context || "(none)"}`;

    // step 4: anthropic extraction
    const systemPrompt = buildExtractionSystemPrompt();
    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: "user", content: userInput }],
    });

    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      // deno-lint-ignore no-explicit-any
      .map((b: any) => b.text)
      .join("\n");

    let extraction: ExtractionResult;
    try {
      extraction = parseExtraction(text);
    } catch (e) {
      const msg = `extraction parse failed: ${(e as Error).message}`;
      await supabase
        .from("site_provisioning_runs")
        .update({
          status: "failed",
          error_message: msg,
          extraction_notes: text.slice(0, 2000),
        })
        .eq("id", runId);
      throw new Error(msg);
    }

    // overrides + indexnow key injection
    const clientJsonOut = extraction.client_json as Record<string, unknown>;
    const site = (clientJsonOut.site || {}) as Record<string, unknown>;
    if (domain_apex) {
      site.domain_apex = domain_apex;
      site.url = `https://${domain_apex}`;
    }
    if (cloudflare_project_name) {
      site.cloudflare_project_name = cloudflare_project_name;
    } else if (!site.cloudflare_project_name || site.cloudflare_project_name === "[TBC]") {
      site.cloudflare_project_name = slugify(String(site.domain_apex || client.business_name || client_id));
    }
    clientJsonOut.site = site;

    const tracking = (clientJsonOut.tracking || {}) as Record<string, unknown>;
    tracking.indexnow_key = indexNowKey();
    clientJsonOut.tracking = tracking;

    // step 5: persist extracted state
    await supabase
      .from("site_provisioning_runs")
      .update({
        status: "extracted",
        fathom_recording_id: resolvedRecordingId || null,
        client_json: clientJsonOut,
        services_json: extraction.services_json,
        areas_json: extraction.areas_json,
        extraction_notes: extraction.extraction_notes,
        error_message: null,
      })
      .eq("id", runId);

    // step 6: dry_run short-circuit
    if (dry_run) {
      return new Response(
        JSON.stringify({
          run_id: runId,
          status: "extracted",
          dry_run: true,
          client_json: clientJsonOut,
          services_json: extraction.services_json,
          areas_json: extraction.areas_json,
          extraction_notes: extraction.extraction_notes,
        }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    // step 7: generate repo from template
    const repoSlug = (cloudflare_project_name as string) || String(site.cloudflare_project_name) || slugify(client.business_name);
    const { repo_name, repo_url } = await generateRepoFromTemplate(repoSlug);

    await supabase
      .from("site_provisioning_runs")
      .update({
        status: "repo_created",
        repo_name,
        repo_url,
      })
      .eq("id", runId);

    // step 7b: copy Cloudflare secrets to the new repo (RankOnMaps is a USER not org —
    // no org-level secret inheritance). Required so the template's existing
    // GitHub Actions deploy workflow can authenticate against Cloudflare Pages.
    const secretCopy = await copySecretsToNewRepo(repo_name).catch((e) => ({ ok: false, detail: (e as Error).message }));
    if (!secretCopy.ok) {
      console.warn(`secret copy partial: ${secretCopy.detail}`);
    }

    // step 8: commit the 3 json files
    await commitFile(
      repo_name,
      "data/client.json",
      JSON.stringify(clientJsonOut, null, 2) + "\n",
      "chore(config): seed client.json from onboarding extraction",
    );
    await commitFile(
      repo_name,
      "data/services.json",
      JSON.stringify(extraction.services_json, null, 2) + "\n",
      "chore(config): seed services.json from onboarding extraction",
    );
    await commitFile(
      repo_name,
      "data/areas.json",
      JSON.stringify(extraction.areas_json, null, 2) + "\n",
      "chore(config): seed areas.json from onboarding extraction",
    );

    // step 9: cloudflare pages auto-deploys via the template's gha. mark as deployed.
    await supabase
      .from("site_provisioning_runs")
      .update({ status: "deployed" })
      .eq("id", runId);

    const siteUrl = String(site.url || `https://${site.domain_apex || ""}`);

    // step 10: route to strategist queue (content_brief is the closest existing kind)
    const proposedPayload = {
      run_id: runId,
      site_url: siteUrl,
      repo_url,
      repo_name,
      domain_apex: site.domain_apex,
      cloudflare_project_name: site.cloudflare_project_name,
      extraction_notes: extraction.extraction_notes,
      headline: `site provisioned for ${client.business_name}`,
      review_focus: [
        "approve brand photos + hero imagery",
        "validate founder bio + signature_skills",
        "confirm certifications + license numbers (any [TBC] needs follow-up)",
        "confirm service-area list + tier ranking",
        "approve voice + tone before custom domain goes live",
      ],
      client_json: clientJsonOut,
      services_json: extraction.services_json,
      areas_json: extraction.areas_json,
    };

    const { queue_id } = await enqueueForStrategist({
      client_id,
      kind: "content_brief",
      priority: 70,
      proposed_payload: proposedPayload,
      source_function: "site-provisioning",
      source_payload: { run_id: runId, repo_name },
      strategist_name: "Mersad",
    });

    await notifyStrategistSlack({
      queue_id,
      kind_label: "SITE PROVISIONED · BRANDING PASS",
      emoji: ":construction_site:",
      client_name: client.business_name,
      client_location: client.primary_city || undefined,
      rows: [
        { label: "repo", value: `<${repo_url}|${repo_name}>` },
        { label: "site", value: siteUrl },
        { label: "vertical", value: String(client.vertical || "[TBC]") },
        { label: "services", value: `${(extraction.services_json as unknown[]).length} drafted` },
        { label: "areas", value: `${(extraction.areas_json as unknown[]).length} drafted` },
      ],
      preview: extraction.extraction_notes || "awaiting branding + photo pass before custom domain swap",
      urgency: "med",
    });

    // step 11: emit milestone win
    await emitWin({
      client_id,
      kind: "milestone",
      headline: `:construction_site: Site provisioned for ${client.business_name} — repo + deploy pipeline live · awaiting Mersad branding pass`,
      detail: `<${repo_url}|${repo_name}> · <${siteUrl}|${site.domain_apex}>`,
      payload: {
        run_id: runId,
        repo_url,
        site_url: siteUrl,
        queue_id,
      },
      source: "site-provisioning",
    });

    return new Response(
      JSON.stringify({
        run_id: runId,
        status: "deployed",
        repo_name,
        repo_url,
        site_url: siteUrl,
        queue_id,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error("site-provisioning failed:", message);
    if (runId) {
      await supabase
        .from("site_provisioning_runs")
        .update({ status: "failed", error_message: message })
        .eq("id", runId);
    }
    return new Response(
      JSON.stringify({ error: message, run_id: runId }),
      { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(req) } },
    );
  }
});
