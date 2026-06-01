// Content editor QA — content-specific deep critique beyond adversarial-qa
// Input: { brief_id, draft_body_md, writer? }
// Checks: brief adherence, E-E-A-T signals, schema fit, voice, named-entity density,
// fabrication, missing outline sections, word count, internal link execution, AI-slop detection

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { enqueueForStrategist, notifyStrategistSlack } from "../_shared/strategist-queue.ts";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";

const QA_SYSTEM = `You are an elite content editor for Rank On Maps. You review draft content against the original brief and decide if it ships, needs revision, or gets rejected.

Strict standards:
- Brief adherence: every outline section must be present + addressed
- E-E-A-T: experience + expertise signals throughout (named contractors, real projects, actual ticket prices)
- Voice: no em-dashes, no AI slop ("delve", "leverage", "robust", "navigate", "moreover"), no preambles, dollar-specific
- Named entities: real companies, real cities, real product names (not placeholder fluff)
- Fabrication check: any specific claim (price, address, license, testimonial) must be verifiable — if unverifiable, flag for [TBC]
- Schema fit: content can actually populate the schema types listed in brief
- Word count: within ±15% of target
- Internal links: actually woven in, not bolted on
- AI-slop scan: paragraphs that read formulaic (3-of-pattern, transition-word stacking, "in conclusion" energy)

Return STRICT JSON:
{
  "verdict": "approve" | "revise" | "reject",
  "score": 0-100,
  "brief_adherence_pct": 0-100,
  "eeat_score": 0-100,
  "voice_score": 0-100,
  "fabrication_flags": [{"claim": string, "line": string, "action": "verify|replace_with_TBC|remove"}],
  "missing_outline_sections": [string],
  "ai_slop_lines": [string],
  "required_fixes": [{"issue": string, "fix": string, "severity": "critical|major|minor"}],
  "praise": [string],
  "publish_ready_after_fixes": boolean
}

Be brutal. A boring/generic article is worse than no article.`;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const { brief_id, draft_body_md, writer } = await req.json();
    if (!brief_id || !draft_body_md) {
      return new Response(JSON.stringify({ error: "brief_id + draft_body_md required" }), { status: 400 });
    }

    const { data: brief } = await supa
      .from("content_briefs")
      .select("id, client_id, target_keyword, outline, entities, schema_requirements, internal_links, word_count_target, tone_notes, clients(business_name, vertical, primary_city)")
      .eq("id", brief_id)
      .single();
    if (!brief) return new Response(JSON.stringify({ error: "brief not found" }), { status: 404 });

    const wordCount = (draft_body_md.match(/\b\w+\b/g) || []).length;

    const aRes = await fetch(ANTHROPIC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 4000,
        system: QA_SYSTEM,
        messages: [{
          role: "user",
          content: `BRIEF:
- Client: ${(brief.clients as { business_name?: string }).business_name} (${(brief.clients as { vertical?: string }).vertical})
- Keyword: ${brief.target_keyword}
- Outline:
${JSON.stringify(brief.outline, null, 2)}
- Entities to cover: ${JSON.stringify(brief.entities)}
- Schema: ${JSON.stringify(brief.schema_requirements)}
- Internal links: ${JSON.stringify(brief.internal_links)}
- Word count target: ${brief.word_count_target} (draft has ${wordCount})
- Tone: ${brief.tone_notes || "default"}

DRAFT:
${draft_body_md.slice(0, 25000)}

Return ONLY the JSON.`,
        }],
      }),
    });
    if (!aRes.ok) {
      return new Response(JSON.stringify({ error: `Anthropic ${aRes.status}: ${await aRes.text()}` }), { status: 500 });
    }
    const aData = await aRes.json();
    const text = aData.content?.[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return new Response(JSON.stringify({ error: "no JSON in qa", raw: text.slice(0, 500) }), { status: 500 });
    const qa = JSON.parse(jsonMatch[0]);

    // Persist the draft + qa
    const { data: draft } = await supa
      .from("content_drafts")
      .insert({
        brief_id,
        client_id: brief.client_id,
        body_md: draft_body_md,
        word_count: wordCount,
        writer: writer || null,
        editor_qa: qa,
        qa_score: qa.score,
        qa_verdict: qa.verdict,
        required_fixes: qa.required_fixes || [],
      })
      .select("id")
      .single();

    // If approved (or near), enqueue final strategist decision
    if (qa.verdict === "approve" || (qa.verdict === "revise" && qa.score >= 70)) {
      const queue = await enqueueForStrategist({
        client_id: brief.client_id,
        kind: "content_draft",
        priority: qa.verdict === "approve" ? 70 : 55,
        proposed_payload: {
          brief_id,
          draft_id: draft!.id,
          qa,
          word_count: wordCount,
          target_keyword: brief.target_keyword,
        },
        source_function: "content-editor-qa",
        source_payload: { brief_id, draft_id: draft!.id },
      });
      await notifyStrategistSlack(
        queue.queue_id,
        `Draft ready for review: *${(brief.clients as { business_name?: string }).business_name}* "${brief.target_keyword}" (QA ${qa.score}/100, ${qa.verdict})`,
      );
      await supa.from("content_briefs").update({ status: "awaiting_strategist" }).eq("id", brief_id);
    } else {
      await supa.from("content_briefs").update({ status: "drafting" }).eq("id", brief_id);
    }

    return new Response(JSON.stringify({ ok: true, draft_id: draft!.id, ...qa }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500 });
  }
});
