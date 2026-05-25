// contract-downsell-coach
// Conversational coach for downsell / churn-save negotiations. Same shape as
// contract-judge-amendment, but:
//   - reads contract_policy WHERE kind='downsell'
//   - persists into contract_downsell_threads + contract_downsell_messages
//   - emits structured proposed_offer payloads rather than allow/review/reject
//     verdicts (downsells are economic recommendations, not policy verdicts)
//
// Invoked from ContractDetail.jsx via supabase.functions.invoke():
//   supabase.functions.invoke('contract-downsell-coach',
//     { body: { thread_id, new_message? } })
//
// new_message is optional. When present, we insert it as a 'closer' message
// before calling Claude. When absent (initial open-thread flow), we assume
// the opening 'closer' message is already in the table OR seeded from
// opening_context on the thread row.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const MODEL = 'claude-sonnet-4-6'

// Tool the coach calls every turn.
//   reply           — conversational text shown to the closer. Required.
//   status_signal   — optional state change for the thread.
//   proposed_offer  — optional structured offer recommendation. When the
//                     coach is concrete enough to name dollars + structure,
//                     it attaches this object; we persist the fields onto
//                     the thread row so the dashboard can surface them
//                     outside the chat bubbles.
const COACH_TOOL = {
  name: 'coach_turn',
  description: 'Respond to the closer in the downsell coaching thread',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'Your conversational reply to the closer. 2-6 sentences. Cite the specific policy rule(s) in play. Plain text only — no markdown.',
      },
      status_signal: {
        type: 'string',
        enum: [
          'discovering',        // still asking why/what — no offer yet
          'proposed_offer',     // a concrete recommendation is on the table
          'hard_floor_hit',     // the closer pushed something below a floor
          'needs_admin',        // request Ben review (sets admin_review_requested=true)
          'ready_to_lock',      // closer and coach have converged; ready to lock
        ],
        description: "OPTIONAL. Only set when the thread state changes this turn. Omit if continuing the same state.",
      },
      proposed_offer: {
        type: 'object',
        description: 'OPTIONAL. Attach when you have enough information to name a concrete offer. The dashboard will persist these fields on the thread for at-a-glance review.',
        properties: {
          summary: {
            type: 'string',
            description: 'One-sentence summary of the offer the closer can read to the client.',
          },
          monthly_value_usd: {
            type: 'number',
            description: 'Recurring monthly value in USD. Use 0 if this is a one-off / project-only offer.',
          },
          upfront_value_usd: {
            type: 'number',
            description: 'Total upfront cash to collect now in USD. Use 0 if structure is purely monthly with no upfront.',
          },
          hosting_plan: {
            type: 'string',
            enum: ['monthly', 'annual', 'none'],
            description: "Which hosting plan the offer includes. 'none' is ONLY valid when the client never had a site we built or hosted.",
          },
          payment_structure: {
            type: 'string',
            description: "Free-text label, e.g. 'upfront', 'split-2', 'monthly', 'finance-3mo'. Use the closest standard label.",
          },
          asset_handover_required: {
            type: 'boolean',
            description: 'True when this is an exit (client leaves entirely). False when they stay on a downsell tier.',
          },
        },
        required: ['summary'],
      },
    },
    required: ['reply'],
  },
}

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors

  const corsHeaders = getCorsHeaders(req)
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

  try {
    const { thread_id, new_message } = await req.json()
    if (!thread_id) return json(400, { error: 'thread_id required' })
    // UUID guard — without this, a malformed thread_id leaks the raw
    // Postgres 'invalid input syntax for type uuid' as a 500. Same fix
    // we applied to regenerate-amended-agreement in bc34f5a.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(thread_id)) return json(400, { error: 'thread_id must be a uuid' })

    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' })

    const supa = createClient(supabaseUrl, serviceKey)

    // 1. Fetch thread + parent contract
    const { data: thread, error: tErr } = await supa
      .from('contract_downsell_threads')
      .select('*, contracts(*)')
      .eq('id', thread_id)
      .maybeSingle()
    if (tErr) return json(500, { error: `thread fetch: ${tErr.message}` })
    if (!thread) return json(404, { error: 'thread not found' })
    if (thread.locked_at) return json(409, { error: 'thread is locked' })

    // 2. Fetch active downsell policy
    const { data: policy, error: pErr } = await supa
      .from('contract_policy')
      .select('policy_text, created_at')
      .eq('active', true)
      .eq('kind', 'downsell')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pErr) return json(500, { error: `policy fetch: ${pErr.message}` })
    if (!policy || !policy.policy_text?.trim()) {
      return json(412, {
        error: 'no active downsell policy — paste CONTRACT-DOWNSELL-POLICY-SEED.md into the Downsell tab at /sales/contracts/policy first',
      })
    }

    const contract = thread.contracts

    // 3. Ensure the opening closer message exists. On the first call after
    //    thread creation, opening_context IS the opening message.
    const { data: existingMessages, error: existErr } = await supa
      .from('contract_downsell_messages')
      .select('id, role')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
    if (existErr) return json(500, { error: `messages fetch: ${existErr.message}` })

    if (!existingMessages?.some(m => m.role === 'closer')) {
      await supa.from('contract_downsell_messages').insert({
        thread_id,
        role: 'closer',
        content: thread.opening_context,
      })
    }

    // 4. If a follow-up new_message arrived, insert after any seed above
    if (new_message && typeof new_message === 'string' && new_message.trim()) {
      await supa.from('contract_downsell_messages').insert({
        thread_id,
        role: 'closer',
        content: new_message.trim(),
      })
    }

    // 5. Re-fetch the full thread in chronological order
    const { data: messages, error: mErr } = await supa
      .from('contract_downsell_messages')
      .select('role, content, metadata, created_at')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
    if (mErr) return json(500, { error: `thread fetch: ${mErr.message}` })

    // 6. Build system prompt. Policy + contract context cached for re-use.
    const systemBlocks = [
      {
        type: 'text',
        text: `You are the OPT Digital downsell coach, in a chat with the closer (a salesperson at OPT Digital). The closer brings you situations where a client wants to reduce scope, pause, or churn. Your job is to help the closer save the relationship at an offer that clears OPT's economics.

You are NOT a gatekeeper. You're a negotiating partner. Help the closer find a yes.

# Coaching pattern (strict)

1. If the closer hasn't told you WHY the client is wobbling, ask one sharp discovery question before recommending anything. Status = discovering.
2. Once you know the why, recommend a concrete offer the closer can read to the client. Attach a proposed_offer payload with the structured fields. Status = proposed_offer.
3. If the closer pushes something below the floors, push back with the floor citation, then offer the closest compliant alternative. Status = hard_floor_hit.
4. If you genuinely don't know (custom financing ask, value-based concession), flag for Ben. Status = needs_admin.
5. When closer and you have converged on a final offer, prompt them to lock the thread. Status = ready_to_lock.

# Formatting rules (strict)

Your reply renders in a chat bubble. Keep it scannable.
- NO markdown. No **bold**, no # headers, no *italics*, no bullet glyphs other than "-". The UI renders plain text only — markdown shows as literal characters.
- 2-6 sentences per turn.
- When you propose dollars, write them out: "$500/mo", "$4,500 over 3 months", "$2,000 upfront vs $6,000 split monthly".
- End with one specific next-step question OR a clear call to action.
- Cite the specific policy rule when you push back.

Always call the coach_turn tool. Always cite the specific policy rule(s) when relevant.

# OPT Digital downsell policy (active)

${policy.policy_text}`,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `# Contract under discussion
- Client: ${contract.client_name}${contract.client_company ? ` (${contract.client_company})` : ''}
- Template: ${contract.contract_type === 'retainer' ? 'Retainer ($9K / 90-day)' : 'Trial ($997 / 14-day)'}
- Current fee on contract: ${contract.fee_amount_usd ? '$' + contract.fee_amount_usd : 'unset'}
- Project period: ${contract.project_period_days ? contract.project_period_days + ' days' : 'unset'}

# Engagement state cues
- "Trial" template + recent created_at → likely new sign-up, trial-stage churn risk. Reminder: trial is mandatory for new sign-ups; no skipping.
- "Retainer" template → mid-engagement situation. Existing client; downsell without re-trialing is allowed.
- If you don't know which it is, ask the closer.`,
      },
    ]

    // 7. Format thread as Claude messages. Closer = user. Coach = assistant.
    const claudeMessages = messages!.map(m => {
      if (m.role === 'closer') {
        return { role: 'user', content: m.content }
      }
      // Coach's prior turns: replay as assistant text, including structured
      // proposed_offer when it was attached. We don't replay the tool_use
      // structure — text is sufficient context.
      let txt = m.content
      const md: any = m.metadata
      if (md?.proposed_offer) {
        const po = md.proposed_offer
        const lines: string[] = []
        if (po.summary) lines.push(`summary: ${po.summary}`)
        if (po.monthly_value_usd != null) lines.push(`monthly: $${po.monthly_value_usd}`)
        if (po.upfront_value_usd != null) lines.push(`upfront: $${po.upfront_value_usd}`)
        if (po.hosting_plan) lines.push(`hosting: ${po.hosting_plan}`)
        if (po.payment_structure) lines.push(`payment: ${po.payment_structure}`)
        if (po.asset_handover_required != null) lines.push(`asset_handover: ${po.asset_handover_required}`)
        if (lines.length) txt += `\n\n[proposed offer at this turn:\n${lines.join('\n')}\n]`
      }
      if (md?.status_signal) {
        txt += `\n\n[status at this turn: ${md.status_signal}]`
      }
      return { role: 'assistant', content: txt }
    })

    // 8. Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemBlocks,
        tools: [COACH_TOOL],
        tool_choice: { type: 'tool', name: 'coach_turn' },
        messages: claudeMessages,
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return json(502, { error: `Claude API error: ${claudeRes.status} ${errText.slice(0, 500)}` })
    }

    const claudeBody = await claudeRes.json()
    const toolUse = claudeBody.content?.find((c: any) => c.type === 'tool_use')
    if (!toolUse?.input) {
      return json(502, { error: 'Claude did not call coach_turn', raw: claudeBody })
    }

    const reply: string          = toolUse.input.reply
    const statusSignal: string|null = toolUse.input.status_signal || null
    const proposedOffer: any     = toolUse.input.proposed_offer || null
    if (!reply || !reply.trim()) {
      // Defensive: tool_use truncation can hand back empty fields. Bail
      // loudly rather than insert NULL content (NOT NULL violation).
      return json(502, {
        error: 'coach returned empty reply',
        stop_reason: claudeBody.stop_reason,
      })
    }

    // 9. Insert coach message with structured metadata
    const { error: insErr } = await supa
      .from('contract_downsell_messages')
      .insert({
        thread_id,
        role: 'coach',
        content: reply,
        metadata: {
          status_signal: statusSignal,
          proposed_offer: proposedOffer,
        },
      })
    if (insErr) return json(500, { error: `message insert: ${insErr.message}` })

    // 10. Update parent thread when coach commits to either an offer or a
    //     status change. We snapshot the latest proposed_offer onto the
    //     thread row for at-a-glance display (the latest values win — the
    //     full history lives in messages).
    const update: Record<string, unknown> = {}
    if (proposedOffer) {
      if (proposedOffer.summary != null)              update.recommended_summary      = proposedOffer.summary
      if (proposedOffer.monthly_value_usd != null)    update.monthly_value_usd        = proposedOffer.monthly_value_usd
      if (proposedOffer.upfront_value_usd != null)    update.upfront_value_usd        = proposedOffer.upfront_value_usd
      if (proposedOffer.hosting_plan != null)         update.hosting_plan             = proposedOffer.hosting_plan
      if (proposedOffer.payment_structure != null)    update.payment_structure        = proposedOffer.payment_structure
      if (proposedOffer.asset_handover_required != null) update.asset_handover_required = proposedOffer.asset_handover_required
    }
    if (statusSignal === 'needs_admin') {
      update.admin_review_requested = true
    }
    if (Object.keys(update).length) {
      await supa.from('contract_downsell_threads').update(update).eq('id', thread_id)
    }

    return json(200, {
      reply,
      status_signal: statusSignal,
      proposed_offer: proposedOffer,
    })
  } catch (err) {
    return json(500, { error: (err as Error).message })
  }
})
