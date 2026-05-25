// contract-judge-amendment
// Conversational judge. Each amendment is a back-and-forth thread:
//   - first call (no prior judge message): produces the initial verdict +
//     inserts both the closer's opening message (idempotent) and the judge
//     response into contract_amendment_messages
//   - follow-up calls: includes full message history + new closer turn,
//     Claude responds conversationally, can shift verdict mid-thread,
//     can propose specific clause language for lock-in
//
// Invoked from ContractDetail.jsx via supabase.functions.invoke():
//   supabase.functions.invoke('contract-judge-amendment',
//     { body: { amendment_id, new_message? } })
//
// new_message is optional. When present, we insert it as a 'closer'
// message before calling Claude. When absent (initial submit flow), we
// assume the opening 'closer' message is already in the table.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const MODEL = 'claude-sonnet-4-6'

// Tool the judge calls every turn. `reply` is the conversational text
// shown to the closer. `verdict` is optional — only set when the judge's
// position changes this turn (allow / review / reject). `proposed_clause`
// is optional — only set when the judge wants to suggest specific wording
// that would resolve the request.
const DISCUSSION_TOOL = {
  name: 'discussion_turn',
  description: 'Respond to the closer in the amendment thread',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'Your conversational reply to the closer. 2-6 sentences. Cite the specific policy rule(s) in play. If the closer is asking about counter-options, walk through 2-3 things they could take back to the client.',
      },
      verdict: {
        type: 'string',
        enum: ['allow', 'review', 'reject'],
        description: "OPTIONAL. Only set when your position has CHANGED or this is the first turn. 'allow'=auto-applicable per policy, 'review'=grey-area or bundled-block, 'reject'=clearly blocked. Omit if you're still discussing options without committing.",
      },
      proposed_clause: {
        type: 'string',
        description: 'OPTIONAL. If you can draft specific clause language that would resolve the request, put it here. The closer will see this as a quotable redline. Omit if discussion is exploratory.',
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
    const { amendment_id, new_message } = await req.json()
    if (!amendment_id) return json(400, { error: 'amendment_id required' })
    // UUID guard — without this, a malformed amendment_id leaks the raw
    // Postgres 'invalid input syntax for type uuid' as a 500. Same fix
    // we applied to regenerate-amended-agreement in bc34f5a.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!UUID_RE.test(amendment_id)) return json(400, { error: 'amendment_id must be a uuid' })

    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' })

    const supa = createClient(supabaseUrl, serviceKey)

    // 1. Fetch amendment + parent contract
    const { data: amendment, error: aErr } = await supa
      .from('contract_amendments')
      .select('*, contracts(*)')
      .eq('id', amendment_id)
      .maybeSingle()
    if (aErr) return json(500, { error: `amendment fetch: ${aErr.message}` })
    if (!amendment) return json(404, { error: 'amendment not found' })
    if (amendment.locked_at) return json(409, { error: 'amendment is locked' })

    // 2. Fetch active policy (scoped to amendment kind — migration 021 added
    //    a parallel 'downsell' kind for the coach function. Without the
    //    explicit filter we could match the wrong row when both are active.)
    const { data: policy, error: pErr } = await supa
      .from('contract_policy')
      .select('policy_text, created_at')
      .eq('active', true)
      .eq('kind', 'amendment')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pErr) return json(500, { error: `policy fetch: ${pErr.message}` })
    if (!policy || !policy.policy_text?.trim()) {
      return json(412, { error: 'no active amendment policy doc — paste seed into the Amendment tab at /sales/contracts/policy first' })
    }

    const contract = amendment.contracts

    // 3. Ensure the opening closer message exists. On the very first call
    //    (initial submit flow) the dashboard doesn't pass new_message —
    //    the requested_change IS the opening message.
    const { data: existingMessages, error: existErr } = await supa
      .from('contract_amendment_messages')
      .select('id, role')
      .eq('amendment_id', amendment_id)
      .order('created_at', { ascending: true })
    if (existErr) return json(500, { error: `messages fetch: ${existErr.message}` })

    if (!existingMessages?.some(m => m.role === 'closer')) {
      await supa.from('contract_amendment_messages').insert({
        amendment_id,
        role: 'closer',
        content: amendment.requested_change,
      })
    }

    // 4. If a follow-up new_message was sent, insert it now (after any
    //    opening message backfill above) so it lands after the seed.
    if (new_message && typeof new_message === 'string' && new_message.trim()) {
      await supa.from('contract_amendment_messages').insert({
        amendment_id,
        role: 'closer',
        content: new_message.trim(),
      })
    }

    // 5. Re-fetch the full thread in chronological order
    const { data: thread, error: tErr } = await supa
      .from('contract_amendment_messages')
      .select('role, content, metadata, created_at')
      .eq('amendment_id', amendment_id)
      .order('created_at', { ascending: true })
    if (tErr) return json(500, { error: `thread fetch: ${tErr.message}` })

    // 6. Build the prompt. Policy + template context are cached.
    const templateContext = contract.contract_type === 'retainer'
      ? RETAINER_CONTEXT
      : TRIAL_CONTEXT

    const systemBlocks = [
      {
        type: 'text',
        text: `You are the OPT Digital contract amendment judge, in a chat with the closer (a salesperson at OPT Digital). The closer brings you client amendment requests and you help them negotiate within OPT's policy.

Your job each turn:
1. If the closer is asking a fresh question, judge it against policy and give a clear verdict.
2. If they're pushing back ("what if we countered with X?"), walk through 2-3 counter-options they could take back to the client.
3. If they're asking for specific wording, draft it.
4. If they're proposing something close to lock-in-able, surface that and use the proposed_clause field.

Be a collaborative negotiator, not a gatekeeper. The closer is on OPT's side trying to close a deal. Your job is to keep them inside the policy guardrails while finding ways to say yes.

# The lock-in confirmation step (important)

A "Generate amended document" button appears in the closer's UI ONLY when BOTH of these are true on your latest turn:
  - verdict = 'allow'
  - proposed_clause is set to the final consolidated clause language

Therefore, do NOT set verdict='allow' WITH a proposed_clause until you have actually finalised the language AND the closer has explicitly agreed to it. The right flow:

  Turn N:   Judge proposes draft language, asks for closer's review. verdict='allow', proposed_clause empty or a draft.
  Turn N+1: Closer says "yes, looks good" or pushes back.
  Turn N+2: If closer agreed, NOW set verdict='allow' AND fill proposed_clause with the FINAL consolidated text covering every clause being amended. End your reply with: "Ready to lock these in. Hit Generate amended document above (or below) to lock and produce the new PDF." This is the moment the button activates.

If you set verdict='allow' + proposed_clause prematurely (before closer confirms), the closer might hit Generate on language they haven't actually approved. Don't do that. Wait for explicit closer agreement.

If you're discussing multiple clauses, the FINAL proposed_clause must contain ALL of them concatenated (separate each with a CLAUSE header line like "CLAUSE 7.2 AMENDMENT — DIRECT DEBIT REMOVAL" followed by the new text). The PDF generator splits on those headers.

# Formatting rules (strict)

Your "reply" field renders in a chat bubble. Keep it scannable:
- NO markdown. Never use **asterisks** for bold, never use # for headers, never use *single asterisks*. The UI renders plain text only — markdown shows as literal characters.
- When the closer's request contains multiple separable asks, break your reply into numbered sections, each on its own line:

  1. [Ask name] — [verdict for this part] — [one to two sentences why, citing the specific policy rule]

  2. [Ask name] — [verdict] — [reasoning]

  3. [Ask name] — [verdict] — [reasoning]

  [closing question to closer about next steps]

- Use blank lines between sections. Two newlines = paragraph break.
- Short sentences. Max 3 sentences per bullet.
- End with one concrete question to the closer when you need information ("Is the client willing to commit to quarterly pre-pay?") OR a clear next step ("If you want me to draft the counter-clause for option 2, say so.")

Always call the discussion_turn tool. Always cite the specific policy rule(s) by name.

# OPT Digital amendment policy (active)

${policy.policy_text}`,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: `# Contract under discussion
- Client: ${contract.client_name}${contract.client_company ? ` (${contract.client_company})` : ''}
- Template: ${contract.contract_type === 'retainer' ? 'Retainer ($9K / 90-day)' : 'Trial ($997 / 14-day)'}
- Fee: ${contract.fee_amount_usd ? '$' + contract.fee_amount_usd : 'unset'}
- Project period: ${contract.project_period_days ? contract.project_period_days + ' days' : 'unset'}

# Template clause map (cite these when reasoning)
${templateContext}

# Bundle detection
Some requests look reasonable on the surface but bundle a blocked clause with an allowed one. Examples:
- "Add monthly reports" (allowed-looking) + "missed report = refund" (blocked) -> review the bundle.
- "14-day cancellation notice" (allowed) + "pro-rata refund of unused month" (blocked) -> review.
- "Termination for convenience" (allowed standalone) + "satisfaction trigger" or "full refund of paid fees" (blocked) -> reject the bundle.
When you spot a bundle, separate the parts and tell the closer which half can survive.`,
      },
    ]

    // 7. Format thread as Claude messages. Closer = user. Judge = assistant.
    const claudeMessages = thread!.map(m => {
      if (m.role === 'closer') {
        return { role: 'user', content: m.content }
      }
      // Judge's prior turns: replay as assistant text. We don't replay the
      // tool_use structure because that complicates multi-turn parsing —
      // the text content is sufficient context for the next turn.
      let txt = m.content
      const md: any = m.metadata
      if (md?.proposed_clause) {
        txt += `\n\n[proposed clause: ${md.proposed_clause}]`
      }
      if (md?.verdict) {
        txt += `\n\n[verdict at this turn: ${md.verdict}]`
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
        tools: [DISCUSSION_TOOL],
        tool_choice: { type: 'tool', name: 'discussion_turn' },
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
      return json(502, { error: 'Claude did not call discussion_turn', raw: claudeBody })
    }

    const reply: string            = toolUse.input.reply
    const verdict: string | null   = toolUse.input.verdict || null
    const proposedClause: string   = toolUse.input.proposed_clause || ''
    if (!reply || !reply.trim()) {
      // Truncation in tool_use mode can hand back an input with missing
      // fields. Bail loudly rather than insert NULL content (which fails
      // the NOT NULL constraint and bubbles back as a Postgres error).
      return json(502, {
        error: 'judge returned empty reply',
        stop_reason: claudeBody.stop_reason,
      })
    }

    // 9. Insert judge message with structured metadata
    const { error: insErr } = await supa
      .from('contract_amendment_messages')
      .insert({
        amendment_id,
        role: 'judge',
        content: reply,
        metadata: {
          verdict,
          proposed_clause: proposedClause,
        },
      })
    if (insErr) return json(500, { error: `message insert: ${insErr.message}` })

    // 10. Update parent amendment fields when the judge gives a verdict
    //     this turn. We always update ai_judged_at; we update verdict
    //     fields only when the judge committed one.
    const update: Record<string, unknown> = {
      ai_judged_at: new Date().toISOString(),
    }
    if (verdict) {
      update.ai_verdict        = verdict
      update.ai_reasoning      = reply
      update.ai_proposed_redline = proposedClause
      update.status =
        verdict === 'allow'  ? 'approved' :
        verdict === 'reject' ? 'rejected' :
        'judged'
    }
    await supa.from('contract_amendments').update(update).eq('id', amendment_id)

    // 11. Slack: only on first verdict per amendment, only when not 'allow'.
    //     We detect "first verdict" by checking whether any prior judge
    //     message had a verdict in its metadata.
    const priorVerdicts = thread!
      .filter(m => m.role === 'judge')
      .some(m => (m.metadata as any)?.verdict)
    if (verdict && verdict !== 'allow' && !priorVerdicts) {
      // Fire-and-forget so the closer's response isn't blocked by a slow
      // Slack webhook (Claude already took ~5-15s; gateway timeout is 60s).
      // postToSlack catches its own errors internally.
      postToSlack({
        verdict,
        reasoning: reply,
        clientName: contract.client_name,
        clauseRef: amendment.clause_reference,
        requestedChange: amendment.requested_change,
        amendmentId: amendment_id,
      }).catch((e) => console.error('Slack post failed:', e))
    }

    return json(200, {
      reply,
      verdict,
      proposed_clause: proposedClause,
    })
  } catch (err) {
    return json(500, { error: (err as Error).message })
  }
})

const RETAINER_CONTEXT = `RETAINER TEMPLATE ($9K / 90-day, marketed as "Work For Free Until We Do"). Key clauses:
- Clause 4: Guarantee (top-3 ranking + DBA "Opt Digital Instructions" + 10 photos/month + 2 reviews/week + 5-day response). Eligibility-gated.
- Clause 4(c): 30 additional days of free service if positive movement but ranking not hit.
- Clause 4(d): mutual decision after extension — retainer or end with no further obligation.
- Clause 7.2: Direct Debit + $1.25/2.9% Stripe fee + $7 dishonour fee + 48h notice for cancel/change.
- Clause 14: 6-month liability cap, indemnity covers negligent/fraudulent/criminal acts.
- Clause 15: unilateral subcontracting consent.
- Clause 16: termination only on breach + 30-day cure.
- Clause 17: 14-day dispute resolution.
- Clause 19.1: NZ governing law.

OFFER vs CONTRACT GAP (important for retainer judgments):
The marketing pitch ("Work For Free Until We Do") implies open-ended free work until ranking. The contract caps free continued service at 30 days past the 90-day guarantee, then requires mutual decision. When client requests extending free work beyond the 30-day cap, treat as REVIEW (not auto-reject) — aligns with offer pitch but exceeds contract mechanic, Ben decides per-deal. Requests for INDEFINITE free work or removing the cap entirely -> REJECT.`

const TRIAL_CONTEXT = `TRIAL TEMPLATE ($997 / 14-day, auto-renews to recurring retainer). Key clauses:
- Clause 4: Continuation of Project — auto-renews to $997/month after 14-day trial unless cancelled in writing.
- Clause 4(g): 30-day cancellation notice required post-trial; fees remain payable during notice.
- Clause 7.2: Payment Authority — irrevocable continuing authority for Stripe DD; 48h notice for changes.
- Clause 7.6: 20% per annum late-payment interest.
- Clause 12.2(d)(e): Website is Developed IP, transfers on completion, hosting fees may apply if OPT continues hosting.
- Clause 14: 6-month liability cap, indemnity covers negligent/fraudulent/criminal acts.
- Clause 15: unilateral subcontracting consent.
- Clause 16.5: Cancellation Notice — 30 days, all fees payable during notice, no pro-rata refund.
- Clause 17: 14-day dispute resolution.
- Clause 19.1: NZ governing law.
(No guarantee clause in this template.)`

async function postToSlack(args: {
  verdict: string
  reasoning: string
  clientName: string
  clauseRef: string | null
  requestedChange: string
  amendmentId: string
}) {
  const webhook = Deno.env.get('SLACK_CONTRACTS_WEBHOOK_URL')
  if (!webhook) return

  const dashboardBase = Deno.env.get('DASHBOARD_BASE_URL')
    || 'https://sales-dashboard-ftct.onrender.com'
  const link = `${dashboardBase}/sales/contracts/pending`

  const verdictLabel = args.verdict === 'reject' ? 'BLOCKED' : 'NEEDS YOUR CALL'
  const text = `*Contract amendment ${verdictLabel}* — ${args.clientName}${args.clauseRef ? ` · ${args.clauseRef}` : ''}`

  const body = {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Request:* ${truncate(args.requestedChange, 600)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Judge reasoning:* ${truncate(args.reasoning, 600)}` } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Open pending queue' }, url: link },
      ]},
    ],
  }

  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('Slack post failed:', err)
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
