// contract-downsell-coach
// Simple conversational coach. Closer types the situation, coach asks
// clarifying questions, then presents 2-4 numbered options. That's it.
//
// Design decisions after the v1 rewrite was too complex:
//   - NO tool-calls. Plain text chat response from Claude.
//   - NO policy gate. Essentials are embedded in the default system
//     prompt so the coach works even before any policy doc is seeded.
//     If a policy is seeded, it layers on top.
//   - NO structured proposed_offer. The "list of options" lives in the
//     chat reply itself, formatted as numbered text. The closer reads it.
//   - Real error surfacing. If something blows up (Anthropic API, DB,
//     parse error), the actual reason flows back to the client so the
//     UI can show it instead of a generic 500.
//
// Invoked from the new-session create flow + the chat reply form:
//   supabase.functions.invoke('contract-downsell-coach',
//     { body: { thread_id, new_message? } })

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'

const MODEL = 'claude-sonnet-4-6'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Baked-in defaults that ground the coach even without a seeded policy.
// These are the constraints from the 2026-05-25 costings session — the
// floors and levers the coach must respect when proposing options. If
// Ben tweaks them later, the policy doc overrides on top.
const DEFAULT_SYSTEM_PROMPT = `You are the OPT Digital downsell coach. A closer is in a chat with you trying to save a client who is wobbling on price, asking to pause, or threatening to leave.

# How you operate (strict)

1. If the closer hasn't given you enough to recommend anything, ask 1 or 2 sharp clarifying questions. Examples of what you might need to know: what's driving the wobble (cash flow, perceived value, business change), what we've delivered so far, what the client's actual ask is, what their financial constraint is.

2. Once you have enough, present 2 to 4 NUMBERED options the closer can take back to the client. Each option:
   - States the price and payment structure plainly ("$1,800/mo for 3 months, paid upfront — $5,400 total")
   - One short line on why it works for both sides
   - Any mandatory pieces (hosting plan, asset handover) if relevant

3. End each turn with a single specific question or call to action — "which of these does the client's situation match best?", or "want me to draft what you'd send back?"

# Format

Plain text only. No markdown. No asterisks, no headers, no bullet dashes. Numbered options use "1.", "2." prefixes.

Total response 4 to 10 sentences including the options.

# Language rules (strict)

- Speak directly. State what the offer is and what it does.
- Do NOT use the "X, not Y" contrast pattern. Avoid sentences like "this is a holding pattern, not a growth phase" or "this is maintenance, not active SEO". Say "this is a holding pattern" or "this is maintenance" and move on.
- Avoid throat-clearing setups like "the trade-off here is…" or "what this really means is…". Just say the thing.

# Economic constraints you must respect

- Absolute monthly floor: $1,500/mo for active retainer service. Below that we lose money on fulfilment basics. Refuse below this for retainer-tier offers.
- Admin-review band: anything between $1,500 and $1,700/mo needs human sign-off — propose it but mark the option as "needs Ben's approval".
- Above $1,700/mo: propose freely.
- Gross margin: 25% is the hard floor, 50% is the aim. Walk options from aim down toward floor — propose the best margin option first, then step down only if client can't reach it.
- Standard COGS: roughly $1,018/mo on a full retainer. Phasing out active link building drops COGS by ~$150/mo if scope can shrink.
- Cash upfront preferred. Locks the client in for the full engagement period and gives us a focused delivery window. Never propose deferred billing.
- Financing: standard package is $4,500 over 3 months ($1,500/mo financed). External financier eats 15% fee, so financing at the $1,500/mo level fails margin without scope trims.
- Existing client downsells: ignore acquisition costs and original commissions (already sunk). Only defend against COGS + financing fee.

# GBP-only tier at $500/mo (NEW)

If the closer says the client doesn't need website work, content, or active SEO and just wants Google Business Profile (GBP / GMB) management, you CAN offer $500/mo for GBP management only. When you propose this tier you MUST also tell the closer to set the following expectations with the client:

- Do not expect ranking changes from this tier.
- Lead volume will be much lower than full retainer.
- Growth is slower.
- The client has to do more of the lifting on their side — generate reviews regularly, supply photos, respond to GMB Q&A, push their own visibility.

This tier exists because GBP-only fulfilment is light enough that $500/mo clears margin. It is a holding tier for clients who want to stay in the OPT ecosystem at low touch.

# Mandatory pieces on save / exit

- Asset handover on full exit: always (website, GBP access, content, reports).
- Hosting plan if we built or host the site: $50/mo or $489/yr upfront. Mandatory.
- Trial is mandatory for new sign-ups; existing clients downselling don't re-trial.

# Tone

You are a negotiating partner. Default to finding a yes inside the economics. When you push back, you always give an alternative the closer can take back.`

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
    if (!UUID_RE.test(thread_id)) return json(400, { error: 'thread_id must be a uuid' })

    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!anthropicKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured on the Edge function' })

    const supa = createClient(supabaseUrl, serviceKey)

    // 1. Thread + (optional) parent contract for fee context
    const { data: thread, error: tErr } = await supa
      .from('contract_downsell_threads')
      .select('*, contracts(client_name, client_company, fee_amount_usd, project_period_days, contract_type)')
      .eq('id', thread_id)
      .maybeSingle()
    if (tErr) return json(500, { error: `thread fetch: ${tErr.message}` })
    if (!thread) return json(404, { error: 'thread not found' })
    if (thread.locked_at) return json(409, { error: 'thread is locked' })

    // 2. Active policy is OPTIONAL — coach works with embedded defaults
    //    when none is seeded. If present, layer on top.
    const { data: policy } = await supa
      .from('contract_policy')
      .select('policy_text')
      .eq('active', true)
      .eq('kind', 'downsell')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const policyAddendum = (policy?.policy_text || '').trim()

    // 3. Ensure opening closer message exists (seed from opening_context)
    const { data: existing, error: existErr } = await supa
      .from('contract_downsell_messages')
      .select('id, role')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
    if (existErr) return json(500, { error: `messages fetch: ${existErr.message}` })

    if (!existing?.some(m => m.role === 'closer')) {
      await supa.from('contract_downsell_messages').insert({
        thread_id, role: 'closer', content: thread.opening_context,
      })
    }

    // 4. New closer turn (follow-up reply)
    if (new_message && typeof new_message === 'string' && new_message.trim()) {
      await supa.from('contract_downsell_messages').insert({
        thread_id, role: 'closer', content: new_message.trim(),
      })
    }

    // 5. Re-fetch full thread
    const { data: messages, error: mErr } = await supa
      .from('contract_downsell_messages')
      .select('role, content, created_at')
      .eq('thread_id', thread_id)
      .order('created_at', { ascending: true })
    if (mErr) return json(500, { error: `thread fetch: ${mErr.message}` })

    // 6. Build system prompt with optional context blocks
    const clientName = thread.client_name || thread.contracts?.client_name || 'the client'
    const clientCo   = thread.client_company || thread.contracts?.client_company || ''
    const contractCtx = thread.contracts ? [
      `\n# Current contract context`,
      `- Client: ${clientName}${clientCo ? ` (${clientCo})` : ''}`,
      `- Template: ${thread.contracts.contract_type === 'retainer' ? 'Retainer ($9K / 90-day)' : 'Trial ($997 / 14-day)'}`,
      thread.contracts.fee_amount_usd ? `- Current fee: $${thread.contracts.fee_amount_usd}` : '',
      thread.contracts.project_period_days ? `- Period: ${thread.contracts.project_period_days} days` : '',
    ].filter(Boolean).join('\n') : `\n# Client context\n- Talking about: ${clientName}${clientCo ? ` (${clientCo})` : ''}\n- No contract on file in the system; rely on what the closer tells you.`

    const systemText = [
      DEFAULT_SYSTEM_PROMPT,
      contractCtx,
      policyAddendum ? `\n# Active downsell policy (overrides defaults)\n${policyAddendum}` : '',
    ].join('\n')

    // 7. Format thread as Claude messages
    const claudeMessages = messages!.map(m => ({
      role: m.role === 'closer' ? 'user' : 'assistant',
      content: m.content,
    }))

    // 8. Call Claude — plain text, no tools
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
        system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
        messages: claudeMessages,
      }),
    })

    if (!claudeRes.ok) {
      const errText = await claudeRes.text()
      return json(502, { error: `Claude API error: ${claudeRes.status} ${errText.slice(0, 500)}` })
    }

    const claudeBody = await claudeRes.json()
    const reply = (claudeBody.content?.find((c: any) => c.type === 'text')?.text || '').trim()
    if (!reply) {
      return json(502, {
        error: 'coach returned empty reply',
        stop_reason: claudeBody.stop_reason || 'unknown',
      })
    }

    // 9. Persist coach turn
    const { error: insErr } = await supa
      .from('contract_downsell_messages')
      .insert({ thread_id, role: 'coach', content: reply })
    if (insErr) return json(500, { error: `message insert: ${insErr.message}` })

    return json(200, { reply })
  } catch (err) {
    return json(500, { error: (err as Error).message || 'unknown coach error' })
  }
})
