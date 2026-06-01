// Adversarial QA agent — critiques deliverables BEFORE they reach the client.
// Used for: content briefs, GBP posts, weekly recaps, citation submissions,
// touchpoint outbound copy, anything draft-state.
//
// Returns verdict: approve / revise / reject + critique + required_fixes.
// Verdict 'reject' or 'revise' blocks the outbound. 'approve' lets it through.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const VOICE_RULES = `ROM voice rules:
- No em-dashes. No semicolons. No AI flourishes.
- No "Welcome back" preambles or "let me know if I can help" closings.
- Sentences short, dollar-specific where applicable, named entities preferred.
- Match Daniel's lowercase tone if the input is casual.
- No fabricated specifics (no invented addresses, phone numbers, license IDs, named testimonials, pricing, square meters).
- No SCIO references anywhere.
- No times in roadmaps (don't say "in week 2" or "by month 3").
- 40-60 word direct-answer paragraphs.`;

const SYSTEM_PROMPT = `You are an elite senior auditor reviewing draft deliverables for Rank On Maps, a local SEO + GEO agency. Your job is to REJECT slop and approve only work that would satisfy a hard-to-please founder named Daniel Girmay.

${VOICE_RULES}

You must return STRICT JSON:
{
  "verdict": "approve" | "revise" | "reject",
  "score": 0-100,
  "critique": "1-3 sentence honest assessment",
  "required_fixes": [
    {"issue": string, "fix": string, "severity": "critical"|"major"|"minor"}
  ]
}

Verdict scale:
- approve (score >= 85): ships as-is, would not embarrass Daniel
- revise (score 60-84): close but needs the listed fixes
- reject (score < 60): the foundation is wrong; rewrite from scratch

Be honest. Be brutal. Default toward 'revise' or 'reject' if anything reads as AI-generated, generic, or off-voice. A boring deliverable is worse than no deliverable.`;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { artifact_type, artifact_id, client_id, content, context } = await req.json();
    if (!content) return new Response(JSON.stringify({ error: "content required" }), { status: 400 });

    const userMessage = `ARTIFACT TYPE: ${artifact_type || "unspecified"}
${context ? `CONTEXT: ${context}\n` : ""}
CONTENT TO REVIEW:

${content}

Return only the JSON verdict.`;

    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}: ${await res.text()}` }), { status: 500 });
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return new Response(JSON.stringify({ error: "No JSON in response", raw: text }), { status: 500 });
    }
    const verdict = JSON.parse(jsonMatch[0]);

    const { data: review } = await supa
      .from("qa_reviews")
      .insert({
        artifact_type,
        artifact_id: artifact_id || null,
        client_id: client_id || null,
        verdict: verdict.verdict,
        score: verdict.score,
        critique: verdict.critique,
        required_fixes: verdict.required_fixes || [],
      })
      .select("id")
      .single();

    return new Response(JSON.stringify({ ok: true, review_id: review?.id, ...verdict }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
