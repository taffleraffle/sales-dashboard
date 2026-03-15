import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://kjfaqhmllagbxjdxlopm.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
)

async function seed() {
  // Get team members
  const { data: members, error: mErr } = await supabase.from('team_members').select('id, name, role')
  if (mErr) { console.error('Error fetching members:', mErr); return }
  console.log('Team members:', members.map(m => `${m.name} (${m.role})`).join(', '))

  const closers = members.filter(m => m.role === 'closer')
  const setters = members.filter(m => m.role === 'setter')

  if (!closers.length || !setters.length) {
    console.error('No closers or setters found. Run the migration first.')
    return
  }

  const today = new Date()
  const fmt = d => d.toISOString().split('T')[0]
  const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return fmt(d) }

  // Seed setter_leads — booked calls for this week
  const leadNames = [
    'Mike Johnson', 'Sarah Chen', 'Tom Williams', 'Lisa Rodriguez', 'James Park',
    'Emily Davis', 'Carlos Martinez', 'Rachel Kim', 'David Brown', 'Amanda White',
    'Kevin Lee', 'Jessica Taylor', 'Ryan Murphy', 'Maria Garcia', 'Chris Anderson',
  ]

  const leads = leadNames.map((name, i) => ({
    setter_id: setters[i % setters.length].id,
    closer_id: closers[i % closers.length].id,
    lead_name: name,
    lead_source: i % 3 === 0 ? 'auto' : 'manual',
    date_set: daysAgo(Math.floor(Math.random() * 5) + 2),
    appointment_date: daysAgo(Math.floor(Math.random() * 6)),
    status: 'set',
  }))

  const { data: insertedLeads, error: lErr } = await supabase.from('setter_leads').insert(leads).select()
  if (lErr) { console.error('Error inserting leads:', lErr); return }
  console.log(`Inserted ${insertedLeads.length} setter_leads`)

  // Seed some closer EOD reports for the last 7 days
  const closerEODs = []
  for (const closer of closers) {
    for (let d = 1; d <= 5; d++) {
      closerEODs.push({
        closer_id: closer.id,
        report_date: daysAgo(d),
        nc_booked: 3 + Math.floor(Math.random() * 3),
        fu_booked: 1 + Math.floor(Math.random() * 2),
        nc_no_shows: Math.floor(Math.random() * 2),
        fu_no_shows: Math.floor(Math.random() * 1),
        live_nc_calls: 2 + Math.floor(Math.random() * 2),
        live_fu_calls: 1,
        offers: 2 + Math.floor(Math.random() * 2),
        closes: Math.floor(Math.random() * 2),
        total_revenue: Math.floor(Math.random() * 2) * (3000 + Math.floor(Math.random() * 5000)),
        total_cash_collected: Math.floor(Math.random() * 2) * (1000 + Math.floor(Math.random() * 2000)),
        is_confirmed: true,
      })
    }
  }

  const { error: ceErr } = await supabase.from('closer_eod_reports').insert(closerEODs)
  if (ceErr) console.error('Error inserting closer EODs:', ceErr)
  else console.log(`Inserted ${closerEODs.length} closer EOD reports`)

  // Seed setter EOD reports
  const setterEODs = []
  for (const setter of setters) {
    for (let d = 1; d <= 5; d++) {
      setterEODs.push({
        setter_id: setter.id,
        report_date: daysAgo(d),
        total_leads: 40 + Math.floor(Math.random() * 30),
        outbound_calls: 80 + Math.floor(Math.random() * 60),
        pickups: 15 + Math.floor(Math.random() * 15),
        meaningful_conversations: 5 + Math.floor(Math.random() * 8),
        sets: 1 + Math.floor(Math.random() * 3),
        reschedules: Math.floor(Math.random() * 2),
        self_rating: 6 + Math.floor(Math.random() * 4),
        is_confirmed: true,
      })
    }
  }

  const { error: seErr } = await supabase.from('setter_eod_reports').insert(setterEODs)
  if (seErr) console.error('Error inserting setter EODs:', seErr)
  else console.log(`Inserted ${setterEODs.length} setter EOD reports`)

  console.log('\nDone! Refresh the dashboard to see data.')
}

seed()
