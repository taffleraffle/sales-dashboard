// contract-judge-amendment
// Called from the dashboard right after a closer submits an amendment.
// Loads the active policy doc + the parent contract + the amendment request,
// calls Claude Sonnet 4.6 with a forced-tool response, persists the verdict,
// and posts to Slack if the verdict needs Ben's call.
//
// Invoked from ContractDetail.jsx via supabase.functions.invoke():
//   supabase.functions.invoke('contract-judge-amendment', { body: { amendment_id } })

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const MODEL = 'claude-sonnet-4-6'

const JUDGE_TOOL = {
  name: 'submit_verdict',
  description: 'Submit your verdict on the amendment request',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['allow', 'review', 'reject'],
        description: 'allow = auto-apply per policy. review = grey-area, escalate to Ben. reject = clearly blocked by policy.',
      },
      reasoning: {
        type: 'string',
        description: 'Two to four sentences. Cite the specific policy rule by name. If it bundles a small reasonable ask with a toxic clause, flag the bundle explicitly.',
      },
      proposed_redline: {
        type: 'string',
        description: 'If verdict=allow, the exact text to add to or replace in the contract. If verdict=review or reject, leave empty string.',
      },
    },
    required: ['verdict', 'reasoning', 'proposed_redline'],
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
    const { amendment_id } = await req.json()
    if (!amendment_id) return json(400, { error: 'amendment_id required' })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
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
    if (amendment.status !== 'pending') {
      return json(409, { error: `amendment already ${amendment.status}`, verdict: amendment.ai_verdict })
    }

    // 2. Fetch active policy
    const { data: policy, error: pErr } = await supa
      .from('contract_policy')
      .select('policy_text, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (pErr) return json(500, { error: `policy fetch: ${pErr.message}` })
    if (!policy || !policy.policy_text?.trim()) {
      return json(412, { error: 'no active policy doc — paste seed into /sales/contracts/policy first' })
    }

    const contract = amendment.contracts

    // 3. Build the prompt. Policy + contract context go in a cached system block
    //    so repeat invocations within the cache TTL avoid re-billing those tokens.
    const systemBlocks = [
      {
        type: 'text',
        text:
`You are the OPT Digital contract amendment judge. You evaluate client-requested changes to OPT Digital service agreements and return a structured verdict: allow, review, or reject.

# OPT Digital amendment policy (active version)

The following policy is your sole source of truth for what is allowed, what needs Ben's escalation, and what is blocked. Cite the relevant rule in your reasoning. If a request is not explicitly covered, default to 'review' rather than guessing.

${policy.policy_text}`,
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text:
`# Decision rubric

- verdict='allow' = the request is clearly covered by an ALLOW rule and can be auto-applied. Closer applies without Ben's involvement. Provide the exact redline text in proposed_redline.
- verdict='review' = the request is grey-area, partially covered, bundles an allowed ask with a blocked one, or requires human judgement. Ben decides manually. proposed_redline should be empty.
- verdict='reject' = the request is clearly covered by a BLOCK rule. No escalation path. proposed_redline should be empty.

# Bundle detection (important)

Some requests look reasonable on the surface but bundle a blocked clause with an allowed one. Examples:
- "Add monthly reports" (allowed-looking) + "missed report = refund" (blocked) → review or reject the bundle, don't auto-apply.
- "14-day cancellation notice" (allowed) + "pro-rata refund of unused month" (blocked) → review.
- "Termination for convenience" (allowed standalone) + "satisfaction trigger" or "full refund of paid fees" (blocked) → reject.

If you detect a bundle where part is allowed and part is blocked, return 'review' and explain the bundle in reasoning so Ben knows which half to keep.

Always call the submit_verdict tool.`,
      },
    ]

    const templateContext = contract.contract_type === 'retainer'
      ? `RETAINER TEMPLATE ($9K / 90-day). Key clauses to reference:
- Clause 4: Guarantee (top-3 ranking + DBA "Opt Digital Instructions" + 10 photos/month + 2 reviews/week + 5-day response). Eligibility-gated; failure to meet eligibility forfeits guarantee.
- Clause 4(c): 30 additional days of free service if positive movement but ranking not hit
- Clause 4(d): mutual decision after extension period — retainer or end relationship
- Clause 7.2: Direct Debit with $1.25/2.9% Stripe fee + $7 dishonour fee + 48h notice for cancel/change
- Clause 14: 6-month liability cap, indemnity covers any negligent/fraudulent/criminal act
- Clause 15: unilateral subcontracting consent
- Clause 16: termination only on breach + 30-day cure
- Clause 17: 14-day dispute resolution
- Clause 19.1: NZ governing law`
      : `TRIAL TEMPLATE ($997 / 14-day, auto-renews to recurring retainer). Key clauses to reference:
- Clause 4: Continuation of Project — auto-renews to $997/month after 14-day trial unless cancelled in writing
- Clause 4(g): 30-day cancellation notice required post-trial; fees remain payable during notice
- Clause 7.2: Payment Authority — irrevocable continuing authority for Stripe DD; 48h notice for changes
- Clause 7.6: 20% per annum late-payment interest
- Clause 12.2(d)(e): Website is Developed IP, transfers on completion, hosting fees may apply if OPT continues hosting
- Clause 14: 6-month liability cap, indemnity covers any negligent/fraudulent/criminal act
- Clause 15: unilateral subcontracting consent
- Clause 16.5: Cancellation Notice — 30 days, all fees payable during notice, no pro-rata refund
- Clause 17: 14-day dispute resolution
- Clause 19.1: NZ governing law
(No guarantee clause in this template.)`

    const userPrompt =
`## Contract
- Client: ${contract.client_name}${contract.client_company ? ` (${contract.client_company})` : ''}
- Template: ${contract.contract_type === 'retainer' ? 'Retainer ($9K / 90-day)' : 'Trial ($997 / 14-day)'}
- Fee: ${contract.fee_amount_usd ? '$' + contract.fee_amount_usd : 'unset'}
- Project period: ${contract.project_period_days ? contract.project_period_days + ' days' : 'unset'}
- Current version: v${contract.version}
- Scope: ${contract.scope_summary || 'standard OPT Digital local SEO services'}

## Template clause map (reference when citing clauses in reasoning)

${templateContext}

## Closer's amendment request

${amendment.clause_reference ? `Clause reference: ${amendment.clause_reference}\n` : ''}${amendment.original_excerpt ? `Original excerpt: "${amendment.original_excerpt}"\n` : ''}
What the client wants: ${amendment.requested_change}`

    // 4. Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemBlocks,
        tools: [JUDGE_TOOL],
        tool_choice: { type: 'tool', name: 'submit_verdict' },
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return json(502, { error: `Claude API error: ${claudeRes.status} ${errText.slice(0, 500)}` })
    }

    const claudeBody = await claudeRes.json()
    const toolUse = claudeBody.content?.find((c: any) => c.type === 'tool_use')
    if (!toolUse?.input) {
      return json(502, { error: 'Claude did not call submit_verdict', raw: claudeBody })
    }

    const verdict: string  = toolUse.input.verdict
    const reasoning: string = toolUse.input.reasoning
    const proposedRedline: string = toolUse.input.proposed_redline || ''

    // 5. Persist verdict. Auto-progress status:
    //    allow  → status='approved' (closer can mark applied)
    //    review → status='judged'   (waiting for Ben in /pending)
    //    reject → status='rejected'
    const nextStatus =
      verdict === 'allow'  ? 'approved' :
      verdict === 'reject' ? 'rejected' :
      'judged'

    const { error: uErr } = await supa
      .from('contract_amendments')
      .update({
        ai_verdict: verdict,
        ai_reasoning: reasoning,
        ai_proposed_redline: proposedRedline,
        ai_judged_at: new Date().toISOString(),
        status: nextStatus,
      })
      .eq('id', amendment_id)
    if (uErr) return json(500, { error: `amendment update: ${uErr.message}` })

    // 6. Slack escalation for grey-area or rejected requests. Reject still
    //    notifies because Ben likely wants visibility on every blocked ask
    //    so he can sense-check whether his policy is too strict.
    if (verdict !== 'allow') {
      await postToSlack({
        verdict,
        reasoning,
        clientName: contract.client_name,
        clauseRef: amendment.clause_reference,
        requestedChange: amendment.requested_change,
        amendmentId: amendment_id,
      })
    }

    return json(200, {
      verdict,
      reasoning,
      proposed_redline: proposedRedline,
      status: nextStatus,
    })
  } catch (err) {
    return json(500, { error: (err as Error).message })
  }
})

async function postToSlack(args: {
  verdict: string
  reasoning: string
  clientName: string
  clauseRef: string | null
  requestedChange: string
  amendmentId: string
}) {
  const webhook = Deno.env.get('SLACK_CONTRACTS_WEBHOOK_URL')
  if (!webhook) return  // silently no-op; Slack is optional

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
