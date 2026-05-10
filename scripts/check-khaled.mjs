import { createClient } from '@supabase/supabase-js'
const url = 'https://kjfaqhmllagbxjdxlopm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const sb = createClient(url, key)

const { data } = await sb.from('ghl_appointments')
  .select('ghl_event_id, ghl_contact_id, contact_name, booked_at, appointment_date, calendar_name, appointment_status')
  .ilike('contact_name', '%Khaled%')
  .order('booked_at', { ascending: false })
console.log(JSON.stringify(data, null, 2))
