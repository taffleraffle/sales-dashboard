import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    // Verify caller is authenticated admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user: caller } } = await callerClient.auth.getUser()
    if (!caller) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    // Check caller is admin
    const { data: callerProfile } = await adminClient
      .from('user_profiles')
      .select('role')
      .eq('auth_user_id', caller.id)
      .single()

    if (!callerProfile || !['admin', 'manager'].includes(callerProfile.role)) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { name, email, role, team_member_id } = await req.json()
    if (!name || !email || !role) {
      return new Response(JSON.stringify({ error: 'name, email, and role are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Create auth user via invite (sends email automatically)
    const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: { display_name: name, role },
    })

    if (inviteError) {
      // If user already exists, return friendly error
      if (inviteError.message?.includes('already been registered')) {
        return new Response(JSON.stringify({ error: 'A user with this email already exists' }), {
          status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
      throw inviteError
    }

    const authUserId = inviteData.user.id

    // If team_member_id provided, link the auth user to existing team member
    if (team_member_id) {
      await adminClient
        .from('team_members')
        .update({ auth_user_id: authUserId, email })
        .eq('id', team_member_id)
    } else {
      // Create a new team member record
      await adminClient
        .from('team_members')
        .insert({
          name,
          email,
          role, // 'closer', 'setter'
          auth_user_id: authUserId,
          is_active: true,
        })
    }

    // If role is admin/manager, also create user_profiles entry
    if (['admin', 'manager', 'viewer'].includes(role)) {
      const { data: linkedMember } = team_member_id
        ? await adminClient.from('team_members').select('id').eq('id', team_member_id).single()
        : { data: null }

      await adminClient
        .from('user_profiles')
        .insert({
          auth_user_id: authUserId,
          display_name: name,
          role, // 'admin', 'manager', 'viewer'
          team_member_id: linkedMember?.id || null,
        })
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Invite sent to ${email}`,
      user_id: authUserId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
