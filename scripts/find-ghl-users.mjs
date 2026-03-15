import { readFileSync } from 'fs'
const data = JSON.parse(readFileSync('C:/Users/Ben/.claude/projects/C--Users-Ben/12449249-7485-424d-bf78-3b7c90c4ff12/tool-results/b01a7bncn.txt', 'utf-8'))
const users = {}
for (const cal of data.calendars || []) {
  for (const tm of cal.teamMembers || []) {
    const uid = tm.userId
    if (uid) {
      if (!users[uid]) users[uid] = []
      users[uid].push(cal.name)
    }
  }
}
for (const [uid, cals] of Object.entries(users)) {
  console.log(uid + ': ' + cals.slice(0, 3).join(' | '))
}
