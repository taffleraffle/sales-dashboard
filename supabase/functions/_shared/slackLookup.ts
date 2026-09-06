// Find a person's Slack member id so nobody has to paste it in by hand.
//
// Ben, 6 Sep 2026: onboarding a closer or setter must wire itself up. Optimus
// mentions people by team_members.slack_user_id (speed-to-lead stamps,
// hand-offs, assignments), and that was the one field still typed in manually.
//
// Two passes, cheapest first:
//   1. users.lookupByEmail on the work email
//   2. users.list matched on real name / display name, which catches people
//      whose Slack account sits on a personal address (Azilyn, 6 Sep)
//
// Returns null rather than throwing: a missing Slack id must never block an
// invite or a save.

const SLACK_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') || ''

function norm(s: string): string {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

async function slack(method: string, params: Record<string, string>): Promise<any> {
  const url = `https://slack.com/api/${method}?` + new URLSearchParams(params).toString()
  const r = await fetch(url, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } })
  return await r.json()
}

/** Slack member id for this person, or null. Never throws. */
export async function findSlackUserId(name: string, email?: string | null): Promise<string | null> {
  if (!SLACK_TOKEN) return null
  try {
    if (email) {
      const byEmail = await slack('users.lookupByEmail', { email })
      if (byEmail?.ok && byEmail.user?.id) return byEmail.user.id
    }

    const target = norm(name)
    if (!target) return null
    const first = target.split(' ')[0]

    let cursor = ''
    let looseHit: string | null = null
    for (let page = 0; page < 5; page++) {
      const list = await slack('users.list', { limit: '200', ...(cursor ? { cursor } : {}) })
      if (!list?.ok) break
      for (const u of (list.members || [])) {
        if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue
        const p = u.profile || {}
        const names = [p.real_name, p.display_name, u.real_name, u.name].filter(Boolean).map(norm)
        // Exact full-name match wins outright
        if (names.includes(target)) return u.id
        // First name alone is a fallback, and only when it is unambiguous
        if (!looseHit && names.some((n: string) => n.split(' ')[0] === first)) looseHit = u.id
        else if (looseHit && names.some((n: string) => n.split(' ')[0] === first) && looseHit !== u.id) looseHit = 'AMBIGUOUS'
      }
      cursor = list.response_metadata?.next_cursor || ''
      if (!cursor) break
    }
    return looseHit && looseHit !== 'AMBIGUOUS' ? looseHit : null
  } catch (_e) {
    return null
  }
}

/** Look the person up and store it on their roster row. Returns the id or null. */
export async function backfillSlackUserId(
  adminClient: any,
  teamMemberId: string,
  name: string,
  email?: string | null,
): Promise<string | null> {
  const id = await findSlackUserId(name, email)
  if (!id) return null
  await adminClient.from('team_members').update({ slack_user_id: id }).eq('id', teamMemberId)
  return id
}
