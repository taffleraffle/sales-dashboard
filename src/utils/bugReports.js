export const URGENCY_META = {
  low:      { label: 'Low',      hint: 'Annoying, not blocking' },
  medium:   { label: 'Medium',   hint: 'Slows someone down' },
  high:     { label: 'High',     hint: 'Blocking part of the job' },
  critical: { label: 'Critical', hint: 'Dashboard unusable / wrong money numbers' },
}

export const STATUS_META = {
  open:        { label: 'Open',        fg: 'var(--down)', bg: 'rgba(200,60,50,0.08)',  border: 'rgba(200,60,50,0.3)' },
  in_progress: { label: 'In progress', fg: 'var(--ink)',  bg: 'var(--accent-soft)',    border: 'var(--accent)' },
  fixed:       { label: 'Fixed',       fg: 'var(--up)',   bg: 'rgba(40,140,80,0.08)',  border: 'rgba(40,140,80,0.3)' },
  closed:      { label: 'Closed',      fg: 'var(--ink-3)', bg: 'transparent',          border: 'var(--rule)' },
}

export const REPRO_LABELS = {
  every_time: 'Yes, every time',
  sometimes: 'Sometimes',
  once: 'Happened once',
}

// Markdown version of a report — goes in the zip so it can be dropped
// straight into Claude Code as the task briefing.
export function reportToMarkdown(report) {
  const lines = [
    `# Bug report: ${report.title}`,
    '',
    `- **Requested by:** ${report.requester_name}`,
    `- **Submitted:** ${new Date(report.created_at).toLocaleString()}`,
    `- **Urgency:** ${URGENCY_META[report.urgency]?.label || report.urgency}`,
    `- **Status:** ${STATUS_META[report.status]?.label || report.status}`,
  ]
  if (report.page_location)  lines.push(`- **Where in the dashboard:** ${report.page_location}`)
  if (report.reproducibility) lines.push(`- **Reproducible:** ${REPRO_LABELS[report.reproducibility] || report.reproducibility}`)
  if (report.browser_device) lines.push(`- **Browser/device:** ${report.browser_device}`)
  lines.push('')
  const section = (heading, body) => { if (body) lines.push(`## ${heading}`, '', body, '') }
  section('What happened', report.what_happened)
  section('Expected behavior', report.expected_behavior)
  section('Steps to reproduce', report.steps_to_reproduce)
  section('Extra notes', report.extra_notes)
  if (report.screenshot_paths?.length) {
    lines.push('## Screenshots', '')
    report.screenshot_paths.forEach(p => lines.push(`- screenshots/${p.split('/').pop()}`))
    lines.push('')
  }
  lines.push('---', '', 'Repo: sales-dashboard (React + Vite + Supabase). Investigate the issue described above and propose a fix.')
  return lines.join('\n')
}
