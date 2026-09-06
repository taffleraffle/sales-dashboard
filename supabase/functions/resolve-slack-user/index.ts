// resolve-slack-user — find a team member's Slack id and store it.
//
// Backs the "Find it for me" button on a person's Team page, and is called
// automatically when someone is invited, so the Slack id is never typed in by
// hand. Optimus mentions people by that id on speed-to-lead stamps, hand-offs
// and assignments.
//
// POST { team_member_id }  (admin or manager only)
//   -> { success, slack_user_id, source: 'email' | 'name' | null }
//
// Deploy: supabase functions deploy resolve-slack-user --project-ref kjfaqhmllagbxjdxlopm

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { findSlackUserId } from '../_shared/slackLookup.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': 'https://sales-dashboard-ftct.onrender.com',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization' }, 401)

    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: { user: caller } } = await callerClient.auth.getUser()
    if (!caller) return json({ error: 'Unauthorized' }, 401)

    const adminClient = createClient(supabaseUrl, serviceKey)
    const { data: profile } = await adminClient
      .from('user_profiles').select('role').eq('auth_user_id', caller.id).single()
    if (!profile || !['admin', 'manager'].includes(profile.role)) {
      return json({ error: 'Admin access required' }, 403)
    }

    const { team_member_id } = await req.json()
    if (!team_member_id) return json({ error: 'team_member_id is required' }, 400)

    const { data: member } = await adminClient
      .from('team_members').select('id, name, email').eq('id', team_member_id).single()
    if (!member) return json({ error: 'No such team member' }, 404)

    const byEmail = member.email ? await findSlackUserId('', member.email) : null
    const slackId = byEmail || await findSlackUserId(member.name, null)
    if (!slackId) {
      return json({
        success: false,
        slack_user_id: null,
        error: `No Slack account found for ${member.name}. Their Slack may use a different email, in which case paste the member ID in by hand.`,
      })
    }

    await adminClient.from('team_members').update({ slack_user_id: slackId }).eq('id', member.id)
    return json({ success: true, slack_user_id: slackId, source: byEmail ? 'email' : 'name' })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
