// site-provisioning-extract — heavy async pipeline for a new client site.
//
// Trigger: HTTP POST { run_id }  (fired by site-provisioning as fire-and-forget)
//
// Reads the pending row from site_provisioning_runs (populated by site-provisioning),
// runs the Anthropic extraction + GitHub repo generation + Cloudflare Pages setup,
// then writes back the final status. Optionally pings webhook_url on completion.
//
// This pattern lets the dispatcher (site-provisioning) return 202 immediately
// without holding the request open for the Anthropic call (which can run 30-90s
// and exceeds the Supabase edge function timeout).

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

const VERTICAL_TEMPLATE_MAP: Record<string, { repo: string; schema_subtype: string }> = {
  wellness: { repo: "rom-site-template-wellness", schema_subtype: "MedicalClinic" },
  medspa: { repo: "rom-site-template-medspa", schema_subtype: "HealthAndBeautyBusiness" },
  finance: { repo: "rom-site-template-finance", schema_subtype: "FinancialService" },
  roofing: { repo: "rom-site-template", schema_subtype: "RoofingContractor" },
  homebuilders: { repo: "rom-site-template", schema_subtype: "GeneralContractor" },
  restoration: { repo: "rom-site-template", schema_subtype: "EmergencyService" },
  default: { repo: "rom-site-template", schema_subtype: "LocalBusiness" },
};

function resolveTemplate(vertical: string | undefined): { repo: string; schema_subtype: string } {
  if (!vertical) return VERTICAL_TEMPLATE_MAP.default;
  return VERTICAL_TEMPLATE_MAP[vertical.toLowerCase()] ?? VERTICAL_TEMPLATE_MAP.default;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function slugify(input: string): string {
  return (input || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function indexNowKey(): string {
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

function buildExtractionSystemPrompt(): string {
  return `You are extracting structured data from a Fathom onboarding-call transcript (plus any extra notes provided) for a new Rank On Maps client. Your output is committed verbatim to a static-site repo and rendered into a marketing website.

Read the input I share next and produce three JSON files. Wrap each in a separate \`\`\`json code block where the FIRST LINE inside the block is a comment naming the file, exactly like:
\`\`\`json
// data/client.json
{ ... }
\`\`\`

Follow voice rules: no em-dashes, no AI flourishes, 40-60 word direct-answer paragraphs, specific not vague, no fabricated specifics (use "[TBC]" if input is silent), trade-specific vocabulary.

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

async function generateRepoFromTemplate(repoName: string, templateRepo: string = GH_TEMPLATE_REPO): Promise<{ repo_name: string; repo_url: string }> {
  const res = await ghFetch(
    `/repos/${GH_OWNER}/${templateRepo}/generate`,
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

async function copySecretsToNewRepo(repoName: string): Promise<{ ok: boolean; detail?: string }> {
  const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!cfToken || !cfAccount) {
    return { ok: false, detail: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing in env" };
  }
  const keyRes = await ghFetch(`/repos/${GH_OWNER}/${repoName}/actions/secrets/public-key`);
  if (!keyRes.ok) {
    return { ok: false, detail: `public-key fetch failed: ${keyRes.status}` };
  }
  const { key, key_id } = await keyRes.json();
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

async function patchDeployWorkflowIfStale(repoName: string, projectName: string): Promise<{ patched: boolean; detail?: string }> {
  const path = ".github/workflows/deploy.yml";
  const getRes = await ghFetch(`/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`);
  if (!getRes.ok) {
    return { patched: false, detail: `fetch ${path} failed: ${getRes.status}` };
  }
  const existing = await getRes.json();
  const decoded = atob((existing.content as string).replace(/\n/g, ""));
  const legacyLiteral = "--project-name=austin-area-roofers";
  if (!decoded.includes(legacyLiteral)) {
    return { patched: false, detail: "deploy.yml already client-slug-driven, no patch needed" };
  }
  const updated = decoded.replace(legacyLiteral, `--project-name=${projectName}`);
  const putRes = await ghFetch(`/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "chore(deploy): pin Cloudflare project name to client slug",
      content: b64encode(updated),
      sha: existing.sha,
    }),
  });
  if (!putRes.ok) {
    return { patched: false, detail: `put ${path} failed: ${putRes.status} ${await putRes.text()}` };
  }
  return { patched: true };
}

async function ensureCloudflarePagesProject(projectName: string): Promise<{ ok: boolean; created: boolean; detail?: string }> {
  const cfToken = Deno.env.get("CLOUDFLARE_API_TOKEN");
  const cfAccount = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
  if (!cfToken || !cfAccount) {
    return { ok: false, created: false, detail: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID missing in env" };
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects`;
  const headers = {
    "Authorization": `Bearer ${cfToken}`,
    "Content-Type": "application/json",
  };
  const getRes = await fetch(`${base}/${projectName}`, { headers });
  if (getRes.ok) {
    return { ok: true, created: false, detail: "project already exists" };
  }
  const createRes = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: projectName, production_branch: "main" }),
  });
  if (!createRes.ok) {
    return { ok: false, created: false, detail: `create failed: ${createRes.status} ${await createRes.text()}` };
  }
  return { ok: true, created: true };
}

function b64encode(s: string): string {
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
  let lastErr = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await ghFetch(
      `/repos/${GH_OWNER}/${repoName}/contents/${encodeURIComponent(path)}`,
      {
        method: "PUT",
        body: JSON.stringify({ message, content: b64encode(contents) }),
      },
    );
    if (res.ok || res.status === 201) return;
    lastErr = `${res.status} ${await res.text()}`;
    if (res.status === 404 || res.status === 409) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (res.status === 422) {
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

async function fireWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("webhook fire failed:", (e as Error).message);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// pipeline — invoked async from site-provisioning dispatcher

async function runPipeline(runId: string): Promise<void> {
  // load the pending row + the request payload it was created with
  const { data: row, error: rowErr } = await supabase
    .from("site_provisioning_runs")
    .select("id, client_id, request_payload, webhook_url, fathom_recording_id")
    .eq("id", runId)
    .maybeSingle();
  if (rowErr || !row) {
    throw new Error(`run row not found: ${rowErr?.message || "missing"}`);
  }
  await supabase
    .from("site_provisioning_runs")
    .update({ status: "extracting", error_message: null })
    .eq("id", runId);

  const payload = (row.request_payload || {}) as Record<string, unknown>;
  const {
    fathom_recording_id,
    fathom_url,
    extra_context,
    domain_apex,
    cloudflare_project_name,
    dry_run,
    prefetched_transcript,
  } = payload;

  // load client
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, business_name, vertical, primary_city, custom_domain, client_json")
    .eq("id", row.client_id)
    .maybeSingle();
  if (clientErr || !client) {
    throw new Error(`client not found: ${clientErr?.message || "missing"}`);
  }

  // fathom transcript
  let transcript = "";
  let resolvedRecordingId = (fathom_recording_id as string) || "";
  if (prefetched_transcript && typeof prefetched_transcript === "string") {
    transcript = prefetched_transcript;
  } else if (fathom_recording_id || fathom_url) {
    try {
      const ft = await fetchFathomTranscript({
        recording_id: fathom_recording_id as string | undefined,
        url: fathom_url as string | undefined,
      });
      if (ft) {
        transcript = ft.transcript;
        resolvedRecordingId = ft.recording_id || resolvedRecordingId;
      }
    } catch (e) {
      console.warn("fathom fetch failed, continuing with empty transcript:", (e as Error).message);
    }
  }

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

  // anthropic extraction
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
      .update({ status: "failed", error_message: msg, extraction_notes: text.slice(0, 2000) })
      .eq("id", runId);
    throw new Error(msg);
  }

  const clientJsonOut = extraction.client_json as Record<string, unknown>;
  const site = (clientJsonOut.site || {}) as Record<string, unknown>;
  if (domain_apex) {
    site.domain_apex = domain_apex;
    site.url = `https://${domain_apex}`;
  }
  if (cloudflare_project_name) {
    site.cloudflare_project_name = cloudflare_project_name;
  } else if (!site.cloudflare_project_name || site.cloudflare_project_name === "[TBC]") {
    site.cloudflare_project_name = slugify(String(site.domain_apex || client.business_name || row.client_id));
  }
  clientJsonOut.site = site;

  const tracking = (clientJsonOut.tracking || {}) as Record<string, unknown>;
  tracking.indexnow_key = indexNowKey();
  clientJsonOut.tracking = tracking;

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

  if (dry_run) {
    if (row.webhook_url) {
      await fireWebhook(row.webhook_url, {
        run_id: runId,
        status: "extracted",
        dry_run: true,
      });
    }
    return;
  }

  // repo generation
  const repoSlug = (cloudflare_project_name as string) || String(site.cloudflare_project_name) || slugify(client.business_name);
  const templateResolution = resolveTemplate(client.vertical);
  const { repo_name, repo_url } = await generateRepoFromTemplate(repoSlug, templateResolution.repo);

  const brand = (clientJsonOut.brand || {}) as Record<string, unknown>;
  brand.schema_subtype = templateResolution.schema_subtype;
  clientJsonOut.brand = brand;

  await supabase
    .from("site_provisioning_runs")
    .update({ status: "repo_created", repo_name, repo_url })
    .eq("id", runId);

  const secretCopy = await copySecretsToNewRepo(repo_name).catch((e) => ({ ok: false, detail: (e as Error).message }));
  if (!secretCopy.ok) console.warn(`secret copy partial: ${secretCopy.detail}`);

  const projectNameForCf = String(site.cloudflare_project_name);
  const deployPatch = await patchDeployWorkflowIfStale(repo_name, projectNameForCf)
    .catch((e) => ({ patched: false, detail: (e as Error).message }));
  console.log(`deploy.yml patch: ${JSON.stringify(deployPatch)}`);

  const pagesProject = await ensureCloudflarePagesProject(projectNameForCf)
    .catch((e) => ({ ok: false, created: false, detail: (e as Error).message }));
  if (!pagesProject.ok) console.warn(`pages project ensure failed: ${pagesProject.detail}`);

  await commitFile(repo_name, "data/client.json", JSON.stringify(clientJsonOut, null, 2) + "\n", "chore(config): seed client.json from onboarding extraction");
  await commitFile(repo_name, "data/services.json", JSON.stringify(extraction.services_json, null, 2) + "\n", "chore(config): seed services.json from onboarding extraction");
  await commitFile(repo_name, "data/areas.json", JSON.stringify(extraction.areas_json, null, 2) + "\n", "chore(config): seed areas.json from onboarding extraction");

  await supabase
    .from("site_provisioning_runs")
    .update({ status: "deployed" })
    .eq("id", runId);

  const siteUrl = String(site.url || `https://${site.domain_apex || ""}`);

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
    client_id: row.client_id,
    kind: "content_brief",
    priority: 70,
    proposed_payload: proposedPayload,
    source_function: "site-provisioning-extract",
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

  await emitWin({
    client_id: row.client_id,
    kind: "milestone",
    headline: `:construction_site: Site provisioned for ${client.business_name} · repo + deploy pipeline live · awaiting Mersad branding pass`,
    detail: `<${repo_url}|${repo_name}> · <${siteUrl}|${site.domain_apex}>`,
    payload: { run_id: runId, repo_url, site_url: siteUrl, queue_id },
    source: "site-provisioning-extract",
  });

  if (row.webhook_url) {
    await fireWebhook(row.webhook_url, {
      run_id: runId,
      status: "deployed",
      repo_url,
      site_url: siteUrl,
      queue_id,
    });
  }
}

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
    runId = body?.run_id || null;
    if (!runId) {
      return new Response(JSON.stringify({ error: "run_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    await runPipeline(runId);
    return new Response(
      JSON.stringify({ run_id: runId, status: "complete" }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error("site-provisioning-extract failed:", message);
    if (runId) {
      await supabase
        .from("site_provisioning_runs")
        .update({ status: "failed", error_message: message })
        .eq("id", runId);
    }
    return new Response(
      JSON.stringify({ error: message, run_id: runId }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
