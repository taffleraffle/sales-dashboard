// Wizard source auto-fetch
// Resolves a paste-reference (Fathom URL, GHL contact email/phone, website URL)
// into a full ingested source row in onboarding_sources.
//
// Body: { session_id, source_type, ref }
//   source_type ∈ "fathom_transcript" | "ghl_contact" | "site_crawl"
//   ref = URL for Fathom/site, or email/phone for GHL

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const FATHOM_BASE = "https://api.fathom.video/v1";

async function fetchFathom(ref: string): Promise<{ body: string; summary: string }> {
  const apiKey = Deno.env.get("FATHOM_API_KEY")!;
  const headers = { "X-Api-Key": apiKey };

  // Resolve to recording_id
  let recId: string | undefined;
  if (/^\d+$/.test(ref.trim())) {
    const r = await fetch(`${FATHOM_BASE}/recordings/by-call-id?call_id=${ref}`, { headers });
    const d = await r.json();
    recId = d.recording_id || d.id;
    if (!recId) {
      // Maybe it IS a recording_id
      recId = ref.trim();
    }
  } else if (ref.startsWith("http")) {
    const r = await fetch(`${FATHOM_BASE}/recordings/by-url?url=${encodeURIComponent(ref)}`, { headers });
    const d = await r.json();
    recId = d.recording_id || d.id;
  }

  if (!recId) throw new Error("Could not resolve Fathom recording");

  const [transcriptRes, summaryRes] = await Promise.all([
    fetch(`${FATHOM_BASE}/recordings/${recId}/transcript`, { headers }),
    fetch(`${FATHOM_BASE}/recordings/${recId}/summary`, { headers }),
  ]);
  const t = await transcriptRes.json();
  const s = await summaryRes.json();
  const transcript = typeof t.transcript === "string"
    ? t.transcript
    : (t.segments || []).map((seg: { speaker?: string; text: string; timestamp?: string }) =>
        `[${seg.timestamp || ""}] ${seg.speaker || "?"}: ${seg.text}`).join("\n");
  const summary = typeof s.summary === "string" ? s.summary : (s.bullets || []).join("\n");
  return { body: transcript, summary: summary || transcript.slice(0, 400) };
}

async function fetchGHLContact(ref: string): Promise<{ body: string; summary: string }> {
  const apiKey = Deno.env.get("VITE_GHL_API_KEY") || Deno.env.get("GHL_API_KEY")!;
  const locationId = Deno.env.get("VITE_GHL_LOCATION_ID") || Deno.env.get("GHL_LOCATION_ID")!;
  const isEmail = ref.includes("@");
  const search = isEmail ? `email=${encodeURIComponent(ref)}` : `phone=${encodeURIComponent(ref)}`;

  const res = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&${search}&limit=1`, {
    headers: { "Authorization": `Bearer ${apiKey}`, "Version": "2021-07-28", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`GHL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const contact = data.contacts?.[0];
  if (!contact) throw new Error(`No GHL contact found for ${ref}`);

  const json = JSON.stringify(contact, null, 2);
  const summary = `Name: ${contact.firstName || ""} ${contact.lastName || ""} · Email: ${contact.email || "-"} · Phone: ${contact.phone || "-"} · Tags: ${(contact.tags || []).join(", ")}`;
  return { body: json, summary };
}

async function fetchSiteCrawl(ref: string): Promise<{ body: string; summary: string }> {
  // Lightweight crawl: fetch the URL + extract title + main copy + structured data
  const url = ref.startsWith("http") ? ref : `https://${ref}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ROMOnboardingBot/1.0)" },
    redirect: "follow",
  });
  const html = await res.text();

  // Extract title
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "";
  const desc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)?.[1] || "";

  // Strip scripts/styles + tags for a coarse body extract
  const stripped = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20000);

  // Try to find JSON-LD blocks
  const jsonLdMatches = Array.from(html.matchAll(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  const jsonLd = jsonLdMatches.map((m) => m[1].trim()).slice(0, 5).join("\n\n");

  const body = `URL: ${url}\nTITLE: ${title}\nDESC: ${desc}\n\nBODY TEXT:\n${stripped}\n\n${jsonLd ? `JSON-LD:\n${jsonLd}` : ""}`;
  const summary = `${title}${desc ? ` — ${desc}` : ""}`.slice(0, 300);
  return { body, summary };
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { session_id, source_type, ref } = await req.json();
    if (!session_id || !source_type || !ref) {
      return new Response(JSON.stringify({ error: "session_id, source_type, ref required" }), { status: 400 });
    }

    let body: string, summary: string;
    if (source_type === "fathom_transcript") ({ body, summary } = await fetchFathom(ref));
    else if (source_type === "ghl_contact") ({ body, summary } = await fetchGHLContact(ref));
    else if (source_type === "site_crawl") ({ body, summary } = await fetchSiteCrawl(ref));
    else return new Response(JSON.stringify({ error: `unsupported source_type: ${source_type}` }), { status: 400 });

    const { data: row, error } = await supa
      .from("onboarding_sources")
      .insert({
        session_id,
        source_type,
        source_ref: ref,
        raw_content: { text: body },
        parsed_summary: summary,
        byte_size: body.length,
        status: "fetched",
        fetched_by: "auto",
      })
      .select("id")
      .single();
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    return new Response(JSON.stringify({ ok: true, source_id: row.id, summary, bytes: body.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
