const SUPABASE_PAT = process.env.SUPABASE_PAT
const PROJECT_REF = 'kjfaqhmllagbxjdxlopm'

const body = `import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
serve(() => new Response(JSON.stringify({ ok: true, msg: 'hello' }), {
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
}))
`

const payload = { slug: 'hello-edge-test', name: 'hello-edge-test', body, verify_jwt: false }
console.log('payload length:', JSON.stringify(payload).length)
console.log('body length:', body.length)

let res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/functions`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
console.log('Deploy:', res.status, await res.text())

if (res.status === 400 || res.status === 409) {
  console.log('Updating via PATCH...')
  res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/hello-edge-test`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${SUPABASE_PAT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, verify_jwt: false }),
  })
  console.log('PATCH:', res.status, await res.text())
}

await new Promise(r => setTimeout(r, 5000))

console.log('\nInvoking...')
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtqZmFxaG1sbGFnYnhqZHhsb3BtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NDU0NjIsImV4cCI6MjA4OTAyMTQ2Mn0.kYJ-4s5uAVieo4cBFRUvDZFYH26kjIbscJZC8vhka7M'
const r2 = await fetch(`https://${PROJECT_REF}.supabase.co/functions/v1/hello-edge-test`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${ANON}`, 'Content-Type': 'application/json' },
  body: '{}',
})
console.log('Invoke:', r2.status, await r2.text())
