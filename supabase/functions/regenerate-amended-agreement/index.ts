// regenerate-amended-agreement
// Renders the FULL contract from structured source, substituting any
// locked amendments in their natural clause position. Previous version
// appended an addendum to a baked PDF template; this version generates
// the contract from scratch using src/data/contracts/{trial,retainer}.js
// (mirrored into templates/*-structured.ts for Deno).
//
// Output: a single PDF where amended clauses sit INSIDE clause 7.2 (or
// wherever), highlighted in yellow with the new agreed text. The
// document reads as the contract with the changes baked in — not as
// the original + a separate addendum.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'
// @ts-ignore — Deno resolves .ts with extension
import { getTemplateFor, fillPlaceholders, indexAmendments } from './templates/contracts.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// sanitizeWinAnsi — pdf-lib's Helvetica only supports WinAnsi (Latin-1
// + a handful). Smart quotes / em dashes / bullets / ellipses crash
// drawText if passed unchanged. We map common Unicode glyphs to their
// safest WinAnsi equivalent BEFORE the catch-all strip so they render
// as readable characters rather than '?'.
//
// Lives at module scope so both the per-request handler AND wrapLines
// (used by the Client Form 2-col table renderer) can call it. Before
// hoisting, wrapLines did only the catch-all strip and killed every
// bullet glyph in the services list to '?'.
function sanitizeWinAnsi(s: string): string {
  if (!s) return ''
  return s
    .replace(/[‘’‚‛]/g, "'")  // single curly + low quotes
    .replace(/[“”„‟]/g, '"')  // double curly + low quotes
    .replace(/–/g, '-')                       // en dash
    .replace(/—/g, '--')                      // em dash
    .replace(/…/g, '...')                     // ellipsis
    .replace(/•/g, '*')                       // bullet
    .replace(/ /g, ' ')                       // nbsp
    .replace(/[​-‍﻿]/g, '')         // zero-width
    // Strip anything still outside WinAnsi. Replace with '?' so missing
    // chars are visible rather than silently dropped.
    .replace(/[^\x00-\xff]/g, '?')
}

serve(async (req) => {
  const cors = handleCors(req)
  if (cors) return cors
  const corsHeaders = getCorsHeaders(req)
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

  try {
    const { contract_id } = await req.json()
    if (!contract_id) return json(400, { error: 'contract_id required' })
    if (typeof contract_id !== 'string' || !UUID_RE.test(contract_id)) {
      return json(400, { error: 'contract_id must be a uuid' })
    }

    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // 1. Fetch contract
    const { data: contract, error: cErr } = await supa
      .from('contracts').select('*').eq('id', contract_id).maybeSingle()
    if (cErr) return json(500, { error: `contract fetch: ${cErr.message}` })
    if (!contract) return json(404, { error: 'contract not found' })

    // 2. Fetch locked amendments
    const { data: amendments, error: aErr } = await supa
      .from('contract_amendments')
      .select('id, clause_reference, requested_change, ai_verdict, final_clause_text, locked_at, ai_proposed_redline, original_excerpt')
      .eq('contract_id', contract_id)
      .not('locked_at', 'is', null)
      .order('locked_at', { ascending: true })
    if (aErr) return json(500, { error: `amendments fetch: ${aErr.message}` })

    const finalised = (amendments || []).filter((a: any) => {
      const t = (a.final_clause_text || a.ai_proposed_redline || '').trim()
      return t.length > 0
    })
    if (finalised.length === 0) {
      return json(409, {
        error: 'No locked amendments with agreed clause language to apply. Resolve the amendment thread in chat first.',
      })
    }

    // 3. Get structured template + build amendment lookup
    const template = getTemplateFor(contract)
    const amendmentsByClause = indexAmendments(finalised)

    // 4. Build PDF from scratch
    const doc = await PDFDocument.create()
    const bold     = await doc.embedFont(StandardFonts.HelveticaBold)
    const regular  = await doc.embedFont(StandardFonts.Helvetica)
    const italic   = await doc.embedFont(StandardFonts.HelveticaOblique)

    // A4 page constants
    const PAGE_W   = 595.28
    const PAGE_H   = 841.89
    const MARGIN_X = 56
    const MARGIN_T = 56
    const MARGIN_B = 56
    const BODY_W   = PAGE_W - MARGIN_X * 2

    // sanitize() delegates to the module-scope sanitizeWinAnsi() so
    // wrapLines (used for the Client Form 2-col table where text gets
    // split BEFORE drawing) shares the same WinAnsi conversion.
    // Previously wrapLines did its own catch-all strip which killed
    // bullets ("•" U+2022) and smart quotes to "?" because they live
    // outside the \x00-\xff range and never got their proper WinAnsi
    // mapping (• -> *, smart-quotes -> regular, etc).
    const sanitize = sanitizeWinAnsi

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    function _unused_kept_to_avoid_unicode_edit_issues(s: string): string {
      if (!s) return ''
      return s
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/–/g, '-')
        .replace(/—/g, '--')
        .replace(/…/g, '...')
        .replace(/•/g, '*')
        .replace(/ /g, ' ')
        .replace(/[​-‍﻿]/g, '')
        .replace(/[^\x00-\xff]/g, '?')
    }

    type DrawState = { page: any; y: number }
    function newPage(): DrawState {
      const page = doc.addPage([PAGE_W, PAGE_H])
      return { page, y: PAGE_H - MARGIN_T }
    }
    function ensureSpace(s: DrawState, needed: number): DrawState {
      if (s.y - needed < MARGIN_B) return newPage()
      return s
    }

    // wrapped text — returns updated draw state. `indent` adds left
    // padding for the wrap area only (label sits at full margin if
    // provided).
    function drawText(s: DrawState, text: string, opts: {
      font?: any; size?: number; lineGap?: number; color?: any;
      indent?: number; label?: string; labelWidth?: number;
    } = {}): DrawState {
      const f = opts.font ?? regular
      const size = opts.size ?? 10
      const gap = opts.lineGap ?? 3
      const color = opts.color ?? rgb(0.08, 0.08, 0.08)
      const indent = opts.indent ?? 0
      const lineHeight = size + gap
      const labelW = opts.labelWidth ?? (opts.label ? Math.max(18, f.widthOfTextAtSize(opts.label, size) + 6) : 0)
      const startX = MARGIN_X + indent
      const textStartX = startX + labelW
      const wrapW = BODY_W - indent - labelW
      const words = sanitize(text).split(/\s+/)
      let line = ''
      let firstLine = true
      const flush = () => {
        s = ensureSpace(s, lineHeight)
        // Label only on the FIRST line
        if (firstLine && opts.label) {
          s.page.drawText(sanitize(opts.label), { x: startX, y: s.y - size, size, font: f, color })
        }
        s.page.drawText(line, { x: textStartX, y: s.y - size, size, font: f, color })
        s.y -= lineHeight
        firstLine = false
      }
      for (const w of words) {
        const test = line ? line + ' ' + w : w
        if (f.widthOfTextAtSize(test, size) > wrapW && line) { flush(); line = w }
        else line = test
      }
      if (line) flush()
      else if (firstLine && opts.label) {
        // Label with no text — still draw the label line
        s = ensureSpace(s, lineHeight)
        s.page.drawText(sanitize(opts.label), { x: startX, y: s.y - size, size, font: f, color })
        s.y -= lineHeight
      }
      return s
    }

    // Yellow-highlighted block for amended clause text. Draws filled
    // rectangle background + dark text on top. Spans page breaks
    // (each segment gets its own background rect).
    function drawAmendedBlock(s: DrawState, text: string): DrawState {
      const leftPad = 12
      const rightPad = 12
      const topPad = 10
      const botPad = 10
      const size = 11
      const lineGap = 4
      const lineHeight = size + lineGap
      const paragraphGap = 6  // extra space between paragraphs
      const blockInnerW = BODY_W - leftPad - rightPad
      const bg = rgb(0.99, 0.95, 0.65)
      const accent = rgb(0.94, 0.78, 0.12)
      const textColor = rgb(0.10, 0.08, 0.02)

      // Split into paragraphs FIRST (preserves the closer's intentional
      // line breaks in multi-paragraph amendments). Then wrap each
      // paragraph's words to the block width. Previous version did a
      // single \s+ split which collapsed \n\n into a single space,
      // flattening multi-paragraph amendments into one block of text.
      const paragraphs = sanitize(text)
        .split(/\n\s*\n+/)
        .map(p => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      const lines: Array<{ text: string; paragraphBreakAfter: boolean }> = []
      for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
        const words = paragraphs[pIdx].split(' ')
        let line = ''
        const flushPara = () => {
          if (line) {
            lines.push({ text: line, paragraphBreakAfter: false })
            line = ''
          }
        }
        for (const w of words) {
          const test = line ? line + ' ' + w : w
          if (bold.widthOfTextAtSize(test, size) > blockInnerW && line) {
            lines.push({ text: line, paragraphBreakAfter: false })
            line = w
          } else {
            line = test
          }
        }
        if (line) lines.push({ text: line, paragraphBreakAfter: pIdx < paragraphs.length - 1 })
      }

      // Distribute across segments respecting page boundaries.
      // Each `Line` entry contributes its own height + an extra gap when
      // it ends a paragraph mid-block.
      type Line = { text: string; paragraphBreakAfter: boolean }
      type Seg = { page: any; startY: number; lines: Line[] }
      const segs: Seg[] = [{ page: s.page, startY: s.y, lines: [] }]
      for (const ln of lines) {
        const isFirstLineOfSeg = segs[segs.length - 1].lines.length === 0
        const extraGap = ln.paragraphBreakAfter ? paragraphGap : 0
        const lineCost = lineHeight + extraGap + (isFirstLineOfSeg ? topPad : 0)
        if (s.y - lineCost < MARGIN_B) {
          s = newPage()
          segs.push({ page: s.page, startY: s.y, lines: [] })
        }
        const seg = segs[segs.length - 1]
        if (seg.lines.length === 0) s.y -= topPad
        seg.lines.push(ln)
        s.y -= lineHeight + extraGap
      }
      s.y -= (botPad - lineGap)

      // Render each segment's bg + accent + text. Lines flagged with
      // paragraphBreakAfter get an extra gap below before the next line.
      for (const seg of segs) {
        const segParagraphGapTotal = seg.lines.reduce((sum, ln) => sum + (ln.paragraphBreakAfter ? paragraphGap : 0), 0)
        const h = topPad + seg.lines.length * lineHeight - lineGap + botPad + segParagraphGapTotal
        seg.page.drawRectangle({ x: MARGIN_X, y: seg.startY - h, width: BODY_W, height: h, color: bg })
        seg.page.drawRectangle({ x: MARGIN_X, y: seg.startY - h, width: 5, height: h, color: accent })
        let lineY = seg.startY - topPad
        for (const ln of seg.lines) {
          seg.page.drawText(ln.text, { x: MARGIN_X + leftPad, y: lineY - size, size, font: bold, color: textColor })
          lineY -= lineHeight + (ln.paragraphBreakAfter ? paragraphGap : 0)
        }
      }

      return s
    }

    // Renders a paragraph object recursively (handles children for nested
    // (i)/(ii) lists).
    function drawParagraph(s: DrawState, para: any, depth = 0): DrawState {
      const indent = depth * 16
      s = drawText(s, fillPlaceholders(para.text, contract), {
        size: 10, lineGap: 3, indent, label: para.label,
      })
      if (para.children) {
        for (const child of para.children) {
          s = drawParagraph(s, child, depth + 1)
        }
      }
      s.y -= 2
      return s
    }

    // Render an entire clause body — original text OR amended block.
    // `amendment._finalText` is the per-clause segment (set by
    // indexAmendments when it splits a bundled "CLAUSE X.X AMENDMENT"
    // text). Falls back to final_clause_text for single-clause amendments
    // where _finalText was set to the same value.
    function drawClauseBody(s: DrawState, clause: any, amendment: any): DrawState {
      if (amendment) {
        const text = amendment._finalText || amendment.final_clause_text || amendment.ai_proposed_redline
        s = drawAmendedBlock(s, text)
        if (amendment.locked_at) {
          s.y -= 4
          s = drawText(s, `(Agreed and locked on ${new Date(amendment.locked_at).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland' })}.)`,
            { font: italic, size: 8, lineGap: 2, color: rgb(0.45, 0.45, 0.45) })
        }
        return s
      }
      if (clause.intro) {
        s = drawText(s, fillPlaceholders(clause.intro, contract), { size: 10, lineGap: 3 })
        s.y -= 2
      }
      if (clause.paragraphs) {
        for (const p of clause.paragraphs) {
          s = drawParagraph(s, p)
        }
      }
      return s
    }

    // ─── Start rendering ─────────────────────────────────────────────
    let s = newPage()

    // Cover header
    s.page.drawText('AMENDED AGREEMENT', { x: MARGIN_X, y: s.y - 22, size: 22, font: bold, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 30
    s.page.drawText(sanitize(template.title), { x: MARGIN_X, y: s.y - 12, size: 11, font: regular, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 18
    s.page.drawText(sanitize(`Version v${(contract.version || 1) + 1}  ·  Contract ID ${contract.id.slice(0, 8)}`),
      { x: MARGIN_X, y: s.y - 9, size: 9, font: regular, color: rgb(0.45, 0.45, 0.45) })
    s.y -= 20

    // Amendments banner
    s = drawAmendedBlock(s, `${finalised.length} clause${finalised.length === 1 ? '' : 's'} have been amended in this version. Amended clauses are highlighted in yellow at their natural position below.`)
    s.y -= 16

    // ─── CLIENT FORM ─────────────────────────────────────────────────
    s = ensureSpace(s, 40)
    s.page.drawText('CLIENT FORM', { x: MARGIN_X, y: s.y - 13, size: 13, font: bold, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 22

    for (const row of template.clientForm.rows) {
      const label = row.label
      const value = fillPlaceholders(row.value, contract)
      const labelW = 160
      const valueLines = wrapLines(value, BODY_W - labelW, regular, 10)
      const rowH = Math.max(1, valueLines.length) * 13 + 6
      s = ensureSpace(s, rowH)
      const rowTopY = s.y
      s.page.drawText(sanitize(label), { x: MARGIN_X, y: s.y - 10, size: 10, font: bold, color: rgb(0.30, 0.30, 0.30) })
      for (let i = 0; i < valueLines.length; i++) {
        s.page.drawText(valueLines[i], { x: MARGIN_X + labelW, y: s.y - 10 - i * 13, size: 10, font: regular, color: rgb(0.08, 0.08, 0.08) })
      }
      s.y -= rowH
      // Row separator
      s.page.drawLine({
        start: { x: MARGIN_X, y: s.y + 2 },
        end:   { x: PAGE_W - MARGIN_X, y: s.y + 2 },
        thickness: 0.3, color: rgb(0.85, 0.85, 0.85),
      })
    }
    s.y -= 10

    for (const para of template.clientForm.declarations) {
      s = drawText(s, fillPlaceholders(para, contract), { size: 10, lineGap: 3 })
      s.y -= 6
    }
    s.y -= 6
    s = drawText(s, template.clientForm.executionLine, { font: italic, size: 10, lineGap: 3, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 16

    // ─── CLIENT TERMS preamble ───────────────────────────────────────
    s = ensureSpace(s, 30)
    s.page.drawText(sanitize(template.preamble.title), { x: MARGIN_X, y: s.y - 13, size: 13, font: bold, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 22
    s = drawText(s, fillPlaceholders(template.preamble.intro, contract), { size: 10, lineGap: 3 })
    s.y -= 14

    // ─── Clauses ─────────────────────────────────────────────────────
    for (const clause of template.clauses) {
      s.y -= 10
      s = ensureSpace(s, 60)
      // Clause header
      s.page.drawText(sanitize(`${clause.number}.  ${clause.title}`), {
        x: MARGIN_X, y: s.y - 12, size: 11.5, font: bold, color: rgb(0.08, 0.08, 0.08),
      })
      s.y -= 18

      const topLevelAmendment = amendmentsByClause[clause.id]

      if (topLevelAmendment) {
        // Whole top-level clause replaced
        s = drawClauseBody(s, clause, topLevelAmendment)
      } else if (clause.sections) {
        // Walk sub-sections (e.g. 7.1, 7.2)
        for (const sec of clause.sections) {
          const subAmendment = amendmentsByClause[sec.id]
          s.y -= 6
          s = ensureSpace(s, 30)
          s.page.drawText(sanitize(`${sec.number}  ${sec.title}`), {
            x: MARGIN_X, y: s.y - 10, size: 10, font: bold, color: rgb(0.22, 0.22, 0.22),
          })
          s.y -= 14
          s = drawClauseBody(s, sec, subAmendment)
        }
      } else {
        s = drawClauseBody(s, clause, null)
      }
    }

    // ─── Signature block ────────────────────────────────────────────
    s.y -= 24
    s = ensureSpace(s, 140)
    s.page.drawLine({ start: { x: MARGIN_X, y: s.y }, end: { x: PAGE_W - MARGIN_X, y: s.y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
    s.y -= 24
    s = drawText(s, 'IN WITNESS WHEREOF, the parties have executed this Agreement as of the dates set forth below.',
      { size: 10, lineGap: 3 })
    s.y -= 20

    const sigColW = (BODY_W - 30) / 2
    s.page.drawText('CLIENT', { x: MARGIN_X, y: s.y - 9, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) })
    s.page.drawText('OPT DIGITAL LIMITED', { x: MARGIN_X + sigColW + 30, y: s.y - 9, size: 9, font: bold, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 46
    s.page.drawLine({ start: { x: MARGIN_X, y: s.y }, end: { x: MARGIN_X + sigColW, y: s.y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) })
    s.page.drawLine({ start: { x: MARGIN_X + sigColW + 30, y: s.y }, end: { x: PAGE_W - MARGIN_X, y: s.y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) })
    s.y -= 12
    s.page.drawText('Signature', { x: MARGIN_X, y: s.y - 8, size: 8, font: italic, color: rgb(0.45, 0.45, 0.45) })
    s.page.drawText('Signature', { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 8, font: italic, color: rgb(0.45, 0.45, 0.45) })
    s.y -= 26
    s.page.drawText(sanitize(`Name: ${contract.client_name || '____________________'}`),
      { x: MARGIN_X, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.page.drawText('Name: ____________________________',
      { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 18
    s.page.drawText('Date: ____________________________', { x: MARGIN_X, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.page.drawText('Date: ____________________________', { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })

    // ─── Save + upload ──────────────────────────────────────────────
    const outBytes = await doc.save()
    const nextVersion = (contract.version || 1) + 1
    const outPath = `${contract_id}/amended-v${nextVersion}.pdf`
    const { error: upErr } = await supa.storage.from('contract-uploads')
      .upload(outPath, outBytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) return json(500, { error: `upload failed: ${upErr.message}` })

    const { error: bumpErr } = await supa.from('contracts')
      .update({ version: nextVersion, amended_pdf_path: outPath })
      .eq('id', contract_id)
    if (bumpErr) return json(500, { error: `version bump: ${bumpErr.message}` })

    const { data: signed, error: sErr } = await supa.storage.from('contract-uploads')
      .createSignedUrl(outPath, 600, {
        download: `${(contract.client_name || 'contract').replace(/[^a-z0-9]+/gi, '-')}-amended-v${nextVersion}.pdf`,
      })
    if (sErr) return json(500, { error: `signed url: ${sErr.message}` })

    return json(200, {
      ok: true,
      version: nextVersion,
      path: outPath,
      signed_url: signed.signedUrl,
      amendments_included: finalised.length,
    })
  } catch (err) {
    return json(500, { error: (err as Error).message, stack: (err as Error).stack })
  }
})

// Helper: wrap a string into lines at a given pixel width (used for the
// CLIENT FORM 2-column table where label column is fixed width).
function wrapLines(text: string, maxW: number, font: any, size: number): string[] {
  if (!text) return ['']
  // Use the full WinAnsi sanitizer (not just the catch-all strip). The
  // previous version killed bullets and smart quotes to '?' because they
  // sit outside \x00-\xff and never got their proper Unicode-to-WinAnsi
  // mapping (• -> *, smart-quotes -> ASCII, em-dash -> --, etc).
  const safe = sanitizeWinAnsi(String(text))
  const out: string[] = []
  for (const rawLine of safe.split('\n')) {
    const words = rawLine.split(/\s+/)
    let line = ''
    for (const w of words) {
      const test = line ? line + ' ' + w : w
      if (font.widthOfTextAtSize(test, size) > maxW && line) { out.push(line); line = w }
      else line = test
    }
    if (line) out.push(line)
  }
  return out.length ? out : ['']
}
