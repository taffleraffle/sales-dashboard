// Closer call → AM handoff brief generator
// Takes a Fathom URL or recording_id, pulls the transcript via Fathom API,
// runs Anthropic extraction with the ROM voice rules to produce:
//   - promises_made     (what the closer committed to on the call)
//   - icp_confirmed     (ideal customer profile validated against)
//   - scope_locked      (services + cadence + price)
//   - red_flags         (warning signs the AM needs to know)
//   - upsell_seeds      (future expansion hooks)
//   - summary           (90s readout)
//
// Trigger:
//   curl -X POST .../handoff-brief -d '{"client_id":"...","fathom_url":"...","closer_name":"Daniel"}'

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const FATHOM_BASE = "https://api.fathom.video/v1";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You are extracting structured handoff data from a sales call between a closer and a prospect for Rank On Maps, a local SEO + GEO agency.

Voice rules (apply to any free-text output):
- No em-dashes. No semicolons. No AI flourishes ("delve", "leverage", "robust", "navigate").
- No "Welcome back" preambles or "let me know if I can help" closings.
- Sentences are short, dollar-specific, named entities.
- Lowercase for casual phrases. Title case for stakeholder names + locations only.

Return STRICT JSON matching this schema:
{
  "promises_made": [{"promise": string, "due_window": string|null, "owner": "ROM"|"client"|"both"}],
  "icp_confirmed": {
    "vertical": string,
    "primary_city": string,
    "service_radius_miles": number|null,
    "avg_ticket": number|null,
    "monthly_leads_needed": number|null,
    "primary_pain": string
  },
  "scope_locked": {
    "package": "maps_only"|"full_stack"|"custom"|null,
    "monthly_fee": number|null,
    "term_months": number|null,
    "trial": boolean,
    "deliverables": [string]
  },
  "red_flags": [string],
  "upsell_seeds": [string],
  "summary": string
}

If a field can't be extracted from the transcript, set it to null or [].
The summary is a single paragraph the AM reads in 90 seconds before their first call. Lead with the dollar number. Name the city. State the package locked. List the 1-2 things that will make or break the relationship.`;

interface HandoffOut {
  promises_made: unknown[];
  icp_confirmed: Record<string, unknown>;
  scope_locked: Record<string, unknown>;
  red_flags: string[];
  upsell_seeds: string[];
  summary: string;
}

async function fathomFetchTranscript(input: { url?: string; recording_id?: string; call_id?: string }): Promise<{ transcript: string; recording_id: string; url: string }> {
  const apiKey = Deno.env.get("FATHOM_API_KEY")!;
  const headers = { "X-Api-Key": apiKey };

  let recId = input.recording_id;
  let recUrl = input.url || "";

  if (input.url && !recId) {
    const res = await fetch(`${FATHOM_BASE}/recordings/by-url?url=${encodeURIComponent(input.url)}`, { headers });
    const data = await res.json();
    recId = data.recording_id || data.id;
    recUrl = data.url || recUrl;
  }
  if (input.call_id && !recId) {
    const res = await fetch(`${FATHOM_BASE}/recordings/by-call-id?call_id=${input.call_id}`, { headers });
    const data = await res.json();
    recId = data.recording_id || data.id;
    recUrl = data.url || recUrl;
  }

  if (!recId) throw new Error("Could not resolve Fathom recording_id");

  const tRes = await fetch(`${FATHOM_BASE}/recordings/${recId}/transcript`, { headers });
  const tData = await tRes.json();
  const transcript = typeof tData.transcript === "string"
    ? tData.transcript
    : (tData.segments || []).map((s: { speaker?: string; text: string; timestamp?: string }) => `[${s.timestamp || ""}] ${s.speaker || "?"}: ${s.text}`).join("\n");

  return { transcript, recording_id: recId, url: recUrl };
}

async function anthropicExtract(transcript: string): Promise<HandoffOut> {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `TRANSCRIPT:\n\n${transcript.slice(0, 100_000)}\n\nReturn ONLY the JSON object. No prose, no markdown fence.` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Anthropic response");
  return JSON.parse(jsonMatch[0]);
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json();
    const { client_id, fathom_url, fathom_recording_id, fathom_call_id, closer_name } = body;
    if (!client_id) return new Response(JSON.stringify({ error: "client_id required" }), { status: 400 });

    const fathom = await fathomFetchTranscript({ url: fathom_url, recording_id: fathom_recording_id, call_id: fathom_call_id });
    const extracted = await anthropicExtract(fathom.transcript);

    const { data: brief } = await supa
      .from("handoff_briefs")
      .insert({
        client_id,
        fathom_recording_id: fathom.recording_id,
        fathom_url: fathom.url,
        closer_name: closer_name || "Daniel Girmay",
        call_date: new Date().toISOString(),
        promises_made: extracted.promises_made,
        icp_confirmed: extracted.icp_confirmed,
        scope_locked: extracted.scope_locked,
        red_flags: extracted.red_flags,
        upsell_seeds: extracted.upsell_seeds,
        summary: extracted.summary,
        raw_transcript: fathom.transcript,
        status: "draft",
      })
      .select("id")
      .single();

    return new Response(JSON.stringify({ ok: true, brief_id: brief?.id, extracted }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
