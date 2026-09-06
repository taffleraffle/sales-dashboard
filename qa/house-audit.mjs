/**
 * House-style audit for the sales dashboard.
 *
 * Scans every page/component JSX file for things that break the
 * onboard.optdigital.io house style, and prints a per-file report.
 *
 * The palette + fonts were repointed in June 2026 (src/index.css), so this
 * does NOT re-check tokens. It looks for the things that survive a token
 * swap: hardcoded off-palette colours, square corners, the retired mono
 * label convention, and raw hex greys that should be ink/rule tokens.
 *
 * Usage:  node qa/house-audit.mjs            (summary)
 *         node qa/house-audit.mjs --detail   (every hit with line numbers)
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const DETAIL = process.argv.includes('--detail')
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7)

// Palette that is allowed to appear as a literal. Everything else in hex
// should be coming from a token.
const ALLOWED_HEX = new Set([
  '#fbfbf9', '#f3f1ec', '#ece9e0', '#ffffff', '#fff',
  '#15161a', '#3b3d44', '#6b6d75', '#8a8d96', '#b6b8be',
  '#e9e6da', '#f0ede4',
  '#f4e14a', '#f1dd45', '#f5c518', '#fef9cc', '#fbf3a8', '#1a1700',
  '#1f7a3a', '#e3f2e6', '#b42318', '#fbe7e3', '#6b7280', '#b88200',
  '#b53e3e', '#e0a93e', '#3e8a5e',
  '#000', '#000000',
].map(s => s.toLowerCase()))

const RULES = [
  {
    id: 'square-corners',
    label: 'Square or near-square corners (house radius is 12-22px on cards, 999px on pills)',
    re: /border-?[Rr]adius:\s*['"]?([0-4])(px)?['"]?[,;}]|rounded-none|borderRadius:\s*0\b/g,
  },
  {
    id: 'off-palette-hex',
    label: 'Hardcoded hex outside the OPT palette',
    re: /#[0-9a-fA-F]{3,8}\b/g,
    filter: (m) => {
      const hex = m[0].toLowerCase()
      if (ALLOWED_HEX.has(hex)) return false
      // rgba-ish 8-digit and 4-digit shorthands of allowed colours slip through
      if (hex.length === 9 && ALLOWED_HEX.has(hex.slice(0, 7))) return false
      return true
    },
  },
  {
    id: 'mono-label',
    label: "font-family: var(--mono) used as a label font (retired, --mono is now Inter Tight anyway)",
    re: /fontFamily:\s*['"]var\(--mono\)['"]/g,
  },
  {
    id: 'dark-surface',
    label: 'Dark background on a surface (house is white cards on #fbfbf9)',
    re: /background(?:Color)?:\s*['"]?(?:#0[0-9a-f]{5}|#1[0-9a-f]{5}|rgba?\(\s*(?:[0-2]?\d)\s*,)/gi,
    filter: (m) => !/#15161a/i.test(m[0]),
  },
  {
    id: 'tiny-radius-class',
    label: 'Tailwind rounded-sm/rounded on elements that should be cards or pills',
    re: /className="[^"]*\brounded-(?:sm|xs)\b[^"]*"/g,
  },
  {
    id: 'uppercase-mono-eyebrow',
    label: 'Inline uppercase micro-label (should use .eyebrow / .kicker)',
    re: /textTransform:\s*['"]uppercase['"][^}]{0,120}?letterSpacing/g,
  },
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(jsx|js)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(SRC).filter(f => !ONLY || f.includes(ONLY))
const report = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  const hits = {}
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m
    while ((m = rule.re.exec(src))) {
      if (rule.filter && !rule.filter(m)) continue
      const line = src.slice(0, m.index).split('\n').length
      ;(hits[rule.id] ||= []).push({ line, text: (lines[line - 1] || '').trim().slice(0, 130) })
    }
  }
  const total = Object.values(hits).reduce((n, a) => n + a.length, 0)
  if (total) report.push({ file: relative(ROOT, file), hits, total })
}

report.sort((a, b) => b.total - a.total)

const byRule = {}
for (const r of report)
  for (const [id, arr] of Object.entries(r.hits)) byRule[id] = (byRule[id] || 0) + arr.length

console.log('\nHOUSE STYLE AUDIT — sales dashboard')
console.log('='.repeat(72))
console.log('\nBy rule:')
for (const rule of RULES) {
  const n = byRule[rule.id] || 0
  console.log(`  ${String(n).padStart(5)}  ${rule.id.padEnd(24)} ${rule.label}`)
}
console.log(`\n  ${String(report.reduce((n, r) => n + r.total, 0)).padStart(5)}  TOTAL across ${report.length} files\n`)

console.log('Worst files:')
for (const r of report.slice(0, DETAIL ? report.length : 25)) {
  const parts = Object.entries(r.hits).map(([id, a]) => `${id}:${a.length}`).join(' ')
  console.log(`  ${String(r.total).padStart(5)}  ${r.file.padEnd(48)} ${parts}`)
  if (DETAIL) {
    for (const [id, arr] of Object.entries(r.hits))
      for (const h of arr.slice(0, 12)) console.log(`           ${id} L${h.line}: ${h.text}`)
  }
}
console.log()
