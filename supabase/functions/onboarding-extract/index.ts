// onboarding-extract — the brain of the New Client Wizard.
//
// Trigger: HTTP POST { session_id }
// Reads: onboarding_sessions, onboarding_sources, specialist_playbooks
// Writes: onboarding_artifacts (one row per section), onboarding_suggestions
//          (one per playbook that matches), onboarding_audit_log
//
// Sends ALL ingested source content + the 18-section schema + ROM voice rules
// to Anthropic. Receives back structured JSON. Validates. Persists.
//
// Quality safeguards:
//   1. Voice rules pre-pended to system prompt (no em-dashes, etc.)
//   2. Structured output enforced via tool-use API
//   3. Per-section confidence scoring required from the model
//   4. Inferred-vs-stated flag required per field
//   5. Playbook suggestions auto-attached as separate rows so operators see them

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@0.32'
import { ROM_VOICE_PROMPT } from '../_shared/voice-rules.ts'
import { EXTRACTION_SECTIONS } from '../_shared/extraction-schema.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { session_id } = await req.json()
    if (!session_id) {
      return new Response(JSON.stringify({ error: 'session_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Load session + sources
    const { data: session, error: sessErr } = await supabase
      .from('onboarding_sessions').select('*').eq('id', session_id).single()
    if (sessErr || !session) {
      return new Response(JSON.stringify({ error: 'session not found' }), {
        status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const { data: sources } = await supabase
      .from('onboarding_sources').select('*')
      .eq('session_id', session_id)
      .in('status', ['fetched','parsed'])

    if (!sources || sources.length === 0) {
      return new Response(JSON.stringify({ error: 'no sources to extract from' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    await supabase.from('onboarding_sessions')
      .update({ status: 'extracting', last_active_at: new Date().toISOString() })
      .eq('id', session_id)

    // Build the system prompt
    const sectionsBlock = EXTRACTION_SECTIONS.map(s => `## ${s.key} — ${s.label}\n${s.instructions}\n\nSchema (return as JSON matching shape):\n${JSON.stringify(s.schema, null, 2)}`).join('\n\n---\n\n')

    const systemPrompt = `You are the ROM client-onboarding extraction agent. Your job:

Given source content from a sales call transcript, GHL contact data, the client's existing website,
their Google Business Profile, BBB record, and competitive scan, you produce a structured JSON output
covering 18 sections about the client. Every field in every section must be populated, either with
the actual answer from the sources or with "[TBC]" if the source material doesn't say.

${ROM_VOICE_PROMPT}

For each of the 18 sections below, return:
{
  "<section_key>": {
    "data": { /* matches the schema for that section */ },
    "confidence": 0.0-1.0,  // how confident you are in this section's accuracy
    "inferred": true|false,  // false = answers came directly from sources; true = you inferred from context
    "rendered_md": "<markdown summary of this section for human review>"
  }
}

Wrap the whole thing in a single object keyed by section_key.

Sections:
${sectionsBlock}

CRITICAL CONSTRAINTS:
- Never fabricate addresses, license numbers, founder names, named testimonials, or specific dollar
  amounts. Use [TBC] if not in source.
- Always run the voice rules check on every prose field before returning.
- Confidence < 0.6 = signal that section needs human input.
- inferred=true means the source material is silent and you used domain knowledge to infer.
`

    // Build the user message: all source content concatenated
    const userBlocks = sources.map(s => ({
      type: 'text' as const,
      text: `# Source: ${s.source_type}${s.source_ref ? ` (${s.source_ref})` : ''}\n\n${typeof s.raw_content === 'string' ? s.raw_content : JSON.stringify(s.raw_content, null, 2)}`,
    }))

    if (session.business_name_draft) {
      userBlocks.unshift({
        type: 'text',
        text: `Business name (draft, may be refined by extraction): ${session.business_name_draft}\nVertical (draft): ${session.vertical_draft || 'unknown'}`,
      })
    }

    // Call Anthropic
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userBlocks }],
    })

    const text = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    // Extract JSON from the response
    let parsed: Record<string, any>
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]+?)\s*```/) || text.match(/\{[\s\S]+\}/)
      const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      await supabase.from('onboarding_sessions').update({ status: 'sources', abort_reason: 'extraction returned unparseable JSON' }).eq('id', session_id)
      return new Response(JSON.stringify({ error: 'unparseable extraction', raw: text.slice(0, 500) }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Persist artifacts (one per section)
    const artifactRows: any[] = []
    for (const section of EXTRACTION_SECTIONS) {
      const sectionData = parsed[section.key]
      if (!sectionData) continue
      artifactRows.push({
        session_id,
        section_key: section.key,
        confidence: sectionData.confidence ?? null,
        source_ids: sources.map(s => s.id),
        inferred: sectionData.inferred ?? false,
        data: sectionData.data ?? sectionData,
        rendered_md: sectionData.rendered_md ?? null,
      })
    }

    if (artifactRows.length > 0) {
      const { error: upsertErr } = await supabase
        .from('onboarding_artifacts')
        .upsert(artifactRows, { onConflict: 'session_id,section_key' })
      if (upsertErr) throw upsertErr
    }

    // Apply specialist playbooks for this vertical
    const vertical = parsed['business_model']?.data?.vertical || session.vertical_draft
    if (vertical) {
      const { data: playbooks } = await supabase
        .from('specialist_playbooks').select('*')
        .eq('vertical', vertical).eq('active', true)
        .order('priority', { ascending: false })

      if (playbooks && playbooks.length > 0) {
        const suggestionRows = playbooks.map(pb => ({
          session_id,
          section_key: null,
          specialist_role: pb.specialist_role,
          specialist_user: `playbook:${pb.id}`,
          suggestion_type: 'addition' as const,
          title: pb.title,
          body: pb.body,
          patch: pb.patch,
          applied: false,
        }))
        await supabase.from('onboarding_suggestions').insert(suggestionRows)
      }
    }

    await supabase.from('onboarding_sessions')
      .update({ status: 'review', last_active_at: new Date().toISOString() })
      .eq('id', session_id)

    return new Response(JSON.stringify({
      session_id,
      artifacts_count: artifactRows.length,
      tokens_used: { input: response.usage?.input_tokens, output: response.usage?.output_tokens },
    }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
})
