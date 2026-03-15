/**
 * Setup auth users for the sales dashboard.
 *
 * This script:
 * 1. Runs the auth migration (adds auth_user_id to team_members, creates user_profiles)
 * 2. Creates Supabase Auth users for each team member
 * 3. Links them via auth_user_id
 * 4. Creates an admin account
 *
 * Prerequisites:
 * - SUPABASE_SERVICE_ROLE_KEY env var (NOT the anon key — needs admin access to create users)
 * - Run: node scripts/setup-auth-users.js
 *
 * You'll need the service role key from: Supabase Dashboard → Settings → API → service_role key
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const readline = require('readline')

// Load env
const env = fs.readFileSync('.env', 'utf8')
const SUPABASE_URL = env.match(/VITE_SUPABASE_URL=(.*)/)?.[1]?.trim()
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SERVICE_KEY) {
  console.error('\n❌ SUPABASE_SERVICE_ROLE_KEY env var is required.')
  console.error('   Get it from: Supabase Dashboard → Settings → API → service_role key')
  console.error('   Run: SUPABASE_SERVICE_ROLE_KEY=your_key node scripts/setup-auth-users.js\n')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

// Users to create
const TEAM_USERS = [
  { name: 'Daniel',  role: 'closer', email: 'daniel@optdigital.io' },
  { name: 'Josh',    role: 'setter', email: 'josh@optdigital.io' },
  { name: 'Leandre', role: 'setter', email: 'leandre@optdigital.io' },
]

const ADMIN_USER = {
  name: 'Ben',
  email: 'ben@opt.co.nz',
  appRole: 'admin',
}

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()) }))
}

async function run() {
  console.log('\n🔐 OPT Sales Dashboard — Auth Setup\n')

  // Step 1: Run migration
  console.log('Step 1: Running auth migration...')
  const migrationSQL = fs.readFileSync('migrations/004_auth_setup.sql', 'utf8')
  const statements = migrationSQL.split(';').map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) {
    const { error } = await supabase.rpc('exec_sql', { sql: stmt })
    if (error && !error.message.includes('already exists')) {
      // Try direct — rpc may not exist, fall back to raw
      console.log('   ⚠ Could not run migration via RPC. Please run migrations/004_auth_setup.sql manually in the Supabase SQL Editor.')
      break
    }
  }
  console.log('   ✓ Migration checked\n')

  // Step 2: Get default password
  const defaultPassword = await prompt('Set default password for all accounts (min 6 chars): ')
  if (defaultPassword.length < 6) {
    console.error('Password must be at least 6 characters.')
    process.exit(1)
  }

  // Step 3: Create team member accounts
  console.log('\nStep 2: Creating team member accounts...')

  // Fetch existing team members
  const { data: members } = await supabase.from('team_members').select('*').eq('is_active', true)

  for (const user of TEAM_USERS) {
    const member = members.find(m => m.name.toLowerCase() === user.name.toLowerCase() && m.role === user.role)
    if (!member) {
      console.log(`   ⚠ No team_member found for ${user.name} (${user.role}) — skipping`)
      continue
    }

    if (member.auth_user_id) {
      console.log(`   ⏭ ${user.name} already linked to auth user ${member.auth_user_id}`)
      continue
    }

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: user.email,
      password: defaultPassword,
      email_confirm: true, // skip email verification
      user_metadata: { name: user.name, role: user.role },
    })

    if (authError) {
      if (authError.message.includes('already been registered')) {
        // User exists — find their ID
        const { data: { users } } = await supabase.auth.admin.listUsers()
        const existing = users.find(u => u.email === user.email)
        if (existing) {
          await supabase.from('team_members').update({ auth_user_id: existing.id, email: user.email }).eq('id', member.id)
          console.log(`   ✓ ${user.name} — linked existing auth user (${user.email})`)
        }
      } else {
        console.error(`   ❌ ${user.name}: ${authError.message}`)
      }
      continue
    }

    // Link auth user to team member
    await supabase.from('team_members')
      .update({ auth_user_id: authData.user.id, email: user.email })
      .eq('id', member.id)

    console.log(`   ✓ ${user.name} — created (${user.email})`)
  }

  // Step 4: Create admin account
  console.log('\nStep 3: Creating admin account...')

  const { data: adminAuth, error: adminError } = await supabase.auth.admin.createUser({
    email: ADMIN_USER.email,
    password: defaultPassword,
    email_confirm: true,
    user_metadata: { name: ADMIN_USER.name, role: 'admin' },
  })

  let adminAuthId = adminAuth?.user?.id
  if (adminError) {
    if (adminError.message.includes('already been registered')) {
      const { data: { users } } = await supabase.auth.admin.listUsers()
      const existing = users.find(u => u.email === ADMIN_USER.email)
      adminAuthId = existing?.id
      console.log(`   ⏭ Admin auth user already exists`)
    } else {
      console.error(`   ❌ Admin: ${adminError.message}`)
    }
  }

  if (adminAuthId) {
    // Check if profile already exists
    const { data: existingProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('auth_user_id', adminAuthId)
      .single()

    if (!existingProfile) {
      await supabase.from('user_profiles').insert({
        auth_user_id: adminAuthId,
        display_name: ADMIN_USER.name,
        role: ADMIN_USER.appRole,
      })
      console.log(`   ✓ Admin profile created (${ADMIN_USER.email})`)
    } else {
      console.log(`   ⏭ Admin profile already exists`)
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(50))
  console.log('Setup complete! Accounts created:\n')
  console.log('  Team Members:')
  for (const u of TEAM_USERS) {
    console.log(`    ${u.name.padEnd(10)} ${u.email.padEnd(25)} ${u.role}`)
  }
  console.log(`\n  Admin:`)
  console.log(`    ${ADMIN_USER.name.padEnd(10)} ${ADMIN_USER.email.padEnd(25)} admin`)
  console.log(`\n  Default password: ${defaultPassword}`)
  console.log('  Users should change their password after first login.\n')
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
