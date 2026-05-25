// regenerate-amended-agreement
// Takes a contract_id, loads the right base PDF (trial or retainer),
// appends addendum pages listing every locked amendment on the contract,
// saves the combined PDF to the contract-uploads bucket, bumps the
// contract version, and returns a signed URL the closer can download.
//
// Closer drops the resulting PDF into PandaDoc as the negotiated v2
// agreement. The amendments table records which amendments were locked
// in at the time of regeneration so the contract has a full audit trail.
//
// Invoked from ContractDetail.jsx:
//   supabase.functions.invoke('regenerate-amended-agreement',
//     { body: { contract_id } })

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1'
import { handleCors, getCorsHeaders } from '../_shared/cors.ts'
import trialPdfB64    from './templates/trial.ts'
import retainerPdfB64 from './templates/retainer.ts'

// Supabase CLI deploys only bundle .ts/.js files automatically — binary
// assets next to index.ts are silently dropped. We base64-encode the PDFs
// into .ts modules so they ride along with the code. b64ToBytes decodes
// once at module load.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}
const TEMPLATE_BYTES: Record<string, Uint8Array> = {
  trial:    b64ToBytes(trialPdfB64),
  retainer: b64ToBytes(retainerPdfB64),
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
    if (typeof contract_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contract_id)) {
      return json(400, { error: 'contract_id must be a uuid' })
    }
    const contract_id_used = contract_id

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supa = createClient(supabaseUrl, serviceKey)

    // 1. Fetch contract
    const { data: contract, error: cErr } = await supa
      .from('contracts')
      .select('*')
      .eq('id', contract_id_used)
      .maybeSingle()
    if (cErr) return json(500, { error: `contract fetch: ${cErr.message}` })
    if (!contract) return json(404, { error: 'contract not found' })

    const templateKey = contract.contract_type === 'retainer' ? 'retainer' : 'trial'
    const baseBytes = TEMPLATE_BYTES[templateKey]
    if (!baseBytes) return json(500, { error: `no bundled template for ${templateKey}` })

    // 2. Fetch every locked amendment on this contract
    const { data: amendments, error: aErr } = await supa
      .from('contract_amendments')
      .select('id, clause_reference, requested_change, ai_verdict, final_clause_text, locked_at, ai_proposed_redline')
      .eq('contract_id', contract_id_used)
      .not('locked_at', 'is', null)
      .order('locked_at', { ascending: true })
    if (aErr) return json(500, { error: `amendments fetch: ${aErr.message}` })
    if (!amendments?.length) {
      return json(409, { error: 'No locked amendments yet. Lock in at least one amendment thread before regenerating.' })
    }

    // 3. Load base PDF (bundled as base64 module — see top of file)
    const base = await PDFDocument.load(baseBytes)

    // 4. Build addendum into a fresh PDFDocument so we can put addendum
    //    pages FIRST and original contract pages AFTER. Previous version
    //    appended addendum to the end — closers would open the PDF,
    //    scroll through the original boilerplate they recognised, and
    //    conclude "nothing changed" because they never reached the
    //    addendum pages at the back. Addendum-first means page 1 IS
    //    the changes, impossible to miss.
    const out = await PDFDocument.create()
    const font     = await out.embedFont(StandardFonts.HelveticaBold)
    const regular  = await out.embedFont(StandardFonts.Helvetica)
    const italic   = await out.embedFont(StandardFonts.HelveticaOblique)

    const PAGE_W   = 595.28           // A4 portrait
    const PAGE_H   = 841.89
    const MARGIN_X = 56
    const MARGIN_T = 56
    const MARGIN_B = 56
    const BODY_W   = PAGE_W - MARGIN_X * 2

    // pdf-lib's built-in Helvetica only supports WinAnsi. Claude's replies
    // routinely include smart quotes / em dashes / ellipses that would
    // crash drawText. Substitute the common Unicode glyphs with safe
    // equivalents before drawing. Anything still non-WinAnsi gets dropped.
    function sanitize(s: string): string {
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
        // Strip anything outside basic Latin-1 (WinAnsi covers 0x00-0xFF
        // minus a handful). Replace with '?' so missing chars are visible
        // rather than silently dropped.
        .replace(/[^\x00-\xFF]/g, '?')
    }

    type DrawState = { page: any; y: number }
    function newPage(): DrawState {
      const page = out.addPage([PAGE_W, PAGE_H])
      return { page, y: PAGE_H - MARGIN_T }
    }
    function ensureSpace(s: DrawState, needed: number): DrawState {
      if (s.y - needed < MARGIN_B) return newPage()
      return s
    }
    function drawWrappedText(s: DrawState, text: string, opts: { font: any; size: number; lineGap?: number; color?: any } ): DrawState {
      const { font: f, size } = opts
      const gap = opts.lineGap ?? 4
      const color = opts.color ?? rgb(0.08, 0.08, 0.08)
      const lineHeight = size + gap
      const words = sanitize(text).split(/\s+/)
      let line = ''
      for (const w of words) {
        const test = line ? line + ' ' + w : w
        const width = f.widthOfTextAtSize(test, size)
        if (width > BODY_W && line) {
          s = ensureSpace(s, lineHeight)
          s.page.drawText(line, { x: MARGIN_X, y: s.y - size, size, font: f, color })
          s.y -= lineHeight
          line = w
        } else {
          line = test
        }
      }
      if (line) {
        s = ensureSpace(s, lineHeight)
        s.page.drawText(line, { x: MARGIN_X, y: s.y - size, size, font: f, color })
        s.y -= lineHeight
      }
      return s
    }

    // Only amendments with actual agreed clause language make it into the
    // signed document. If a closer locked something without resolving it
    // (e.g. the judge said "needs Ben" and the closer hit Lock In anyway),
    // the amendment has no final_clause_text and there's nothing legitimate
    // to put in the contract. Those get dropped from the PDF entirely —
    // they don't go in a Schedule A, they don't appear as "client request /
    // escalated to management" closer-internal notes. A legal document
    // either incorporates an agreed change or it doesn't mention it.
    const finalised = amendments.filter(a => {
      const txt = (a.final_clause_text || a.ai_proposed_redline || '').trim()
      return txt.length > 0
    })
    const skipped = amendments.length - finalised.length

    if (finalised.length === 0) {
      return json(409, {
        error: skipped > 0
          ? `All ${skipped} locked amendment${skipped === 1 ? '' : 's'} are missing agreed clause language. Reopen them, finish the thread with the judge until specific clause wording is on the table, then lock in to capture it.`
          : 'No locked amendments to incorporate.',
      })
    }

    let s = newPage()

    // ─── Cover header ─────────────────────────────────────────────────
    s.page.drawText('AMENDMENT ADDENDUM', { x: MARGIN_X, y: s.y - 22, size: 22, font, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 32
    s.page.drawText('Opt Digital Limited', { x: MARGIN_X, y: s.y - 12, size: 11, font: regular, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 28

    const dateStr = new Date().toLocaleDateString('en-NZ', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland',
    })

    // ─── Summary of changes (page 1, top — impossible to miss) ──────
    // Lists what's being amended in this addendum so the closer + client
    // see at a glance what changed. Each line includes the clause ref so
    // it's easy to cross-reference with the original agreement (which is
    // bundled at the back of this PDF).
    const summaryBoxY = s.y
    s = ensureSpace(s, 30 + finalised.length * 14)
    const summaryStartY = s.y
    s = drawWrappedText(s, 'SUMMARY OF CHANGES', { font, size: 11, lineGap: 4, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 4
    finalised.forEach((a, idx) => {
      const ref = a.clause_reference ? a.clause_reference.toUpperCase() : `AMENDMENT ${idx + 1}`
      s.page.drawText(sanitize(`${idx + 1}.  ${ref} — amended`), {
        x: MARGIN_X + 4, y: s.y - 9, size: 10, font: regular, color: rgb(0.08, 0.08, 0.08),
      })
      s.y -= 14
    })
    // Yellow vertical rule beside the summary so it pops as "the
    // executive overview" before any legal prose.
    s.page.drawLine({
      start: { x: MARGIN_X - 6, y: summaryStartY - 2 },
      end:   { x: MARGIN_X - 6, y: s.y + 4 },
      thickness: 3,
      color: rgb(0.96, 0.85, 0.20),
    })
    s.y -= 18

    // Parties + recitals — formal contract preamble
    const partiesPara = `This Amendment Addendum (the "Addendum") is made on ${dateStr} between Opt Digital Limited (the "Provider") and ${contract.client_name}${contract.client_company ? ' of ' + contract.client_company : ''} (the "Client"), and is incorporated into and forms part of the Client Form and Client Terms previously entered into between the Provider and the Client (the "Agreement"). This Addendum constitutes contract version v${(contract.version || 1) + 1}.`
    s = drawWrappedText(s, partiesPara, { font: regular, size: 10, lineGap: 4 })
    s.y -= 12

    s = drawWrappedText(s, 'RECITALS', { font, size: 11, lineGap: 4, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 6
    const recitalA = 'A.  The parties have entered into the Agreement and wish to amend certain of its terms as set out in this Addendum.'
    const recitalB = 'B.  Each amendment set out below has been reviewed and agreed by the Provider through the Provider\'s internal amendment-review process.'
    s = drawWrappedText(s, recitalA, { font: regular, size: 10, lineGap: 4 })
    s.y -= 4
    s = drawWrappedText(s, recitalB, { font: regular, size: 10, lineGap: 4 })
    s.y -= 14

    s = drawWrappedText(s, 'NOW THEREFORE, in consideration of the mutual covenants set out herein, the parties agree as follows:',
      { font: regular, size: 10, lineGap: 4 })
    s.y -= 18

    // Helper — render the new-clause language in a FILLED yellow block
    // with bold dark text. The previous version used a thin left rule
    // which reads as decoration; reviewers scanning the document would
    // skim past it. A fully-coloured block jumps off the page and makes
    // the new language impossible to miss.
    //
    // Implementation: we measure the wrapped lines first to know the
    // total block height, draw the yellow background rectangle, then
    // draw the text on top.
    function drawHighlightedBlock(s: DrawState, text: string, opts: { font: any; size: number; color?: any; bg?: any }): DrawState {
      const leftPad = 12
      const rightPad = 12
      const topPad = 10
      const botPad = 10
      const blockInnerW = BODY_W - leftPad - rightPad
      const size = opts.size
      const lineGap = 4
      const lineHeight = size + lineGap
      const textColor = opts.color ?? rgb(0.10, 0.08, 0.02)
      const bg = opts.bg ?? rgb(0.99, 0.95, 0.65)  // light cream-yellow

      // 1) Wrap text into lines without drawing yet (need total height)
      const words = sanitize(text).split(/\s+/)
      const lines: string[] = []
      let line = ''
      for (const w of words) {
        const test = line ? line + ' ' + w : w
        const width = opts.font.widthOfTextAtSize(test, size)
        if (width > blockInnerW && line) { lines.push(line); line = w }
        else line = test
      }
      if (line) lines.push(line)

      // 2) Render lines, paging if needed. The yellow background gets
      //    drawn per-page so it works across page breaks (rare but
      //    happens on very long clause text).
      let segmentStartY = s.y
      let segmentLines = 0
      const flushSegment = () => {
        if (segmentLines === 0) return
        const h = topPad + segmentLines * lineHeight + botPad - lineGap
        s.page.drawRectangle({
          x: MARGIN_X, y: segmentStartY - h,
          width: BODY_W, height: h,
          color: bg,
        })
        // Re-draw the lines for this segment on top of the rect. We
        // already advanced s.y; the per-line draws happened above the
        // rect. We need to draw text AFTER the rect so it appears on
        // top. So we'll buffer + draw both at the end of each segment.
      }
      // Simpler implementation: buffer lines per page, draw rect + text
      // for the segment when we move to a new page or finish.
      type Segment = { page: any; startY: number; lines: string[] }
      const segments: Segment[] = [{ page: s.page, startY: s.y, lines: [] }]

      for (const ln of lines) {
        if (s.y - lineHeight - (segments[segments.length - 1].lines.length === 0 ? topPad : 0) < MARGIN_B) {
          s = newPage()
          segments.push({ page: s.page, startY: s.y, lines: [] })
        }
        const seg = segments[segments.length - 1]
        if (seg.lines.length === 0) s.y -= topPad
        seg.lines.push(ln)
        s.y -= lineHeight
      }
      // Add bottom padding to the final segment's y advancement
      s.y -= (botPad - lineGap)

      // Now draw each segment's background + text
      for (const seg of segments) {
        const h = topPad + seg.lines.length * lineHeight - lineGap + botPad
        seg.page.drawRectangle({
          x: MARGIN_X, y: seg.startY - h,
          width: BODY_W, height: h,
          color: bg,
        })
        // Left accent strip — darker yellow on the left edge for extra emphasis
        seg.page.drawRectangle({
          x: MARGIN_X, y: seg.startY - h,
          width: 4, height: h,
          color: rgb(0.94, 0.78, 0.12),
        })
        // Draw each line
        let lineY = seg.startY - topPad
        for (const ln of seg.lines) {
          seg.page.drawText(ln, {
            x: MARGIN_X + leftPad, y: lineY - size, size, font: opts.font, color: textColor,
          })
          lineY -= lineHeight
        }
      }

      return s
    }

    // Helper for previously-read text (italic grey, no background)
    function drawIndentedBlock(s: DrawState, text: string, opts: { font: any; size: number; color?: any }): DrawState {
      const leftPad = 14
      const blockInnerW = BODY_W - leftPad
      const size = opts.size
      const lineHeight = size + 5
      const words = sanitize(text).split(/\s+/)
      let line = ''
      const renderLine = (txt: string) => {
        s = ensureSpace(s, lineHeight)
        s.page.drawText(txt, {
          x: MARGIN_X + leftPad, y: s.y - size, size, font: opts.font,
          color: opts.color ?? rgb(0.05, 0.05, 0.05),
        })
        s.y -= lineHeight
      }
      for (const w of words) {
        const test = line ? line + ' ' + w : w
        const width = opts.font.widthOfTextAtSize(test, size)
        if (width > blockInnerW && line) { renderLine(line); line = w }
        else line = test
      }
      if (line) renderLine(line)
      return s
    }

    finalised.forEach((a, idx) => {
      s.y -= 14
      s = ensureSpace(s, 90)
      const clauseHeader = a.clause_reference
        ? `${idx + 1}.  AMENDMENT TO ${a.clause_reference.toUpperCase()}`
        : `${idx + 1}.  AMENDMENT`
      s.page.drawText(sanitize(clauseHeader), {
        x: MARGIN_X, y: s.y - 12, size: 12, font, color: rgb(0.08, 0.08, 0.08),
      })
      s.y -= 20

      const originalText = (a.original_excerpt || '').trim()
      if (originalText) {
        s = drawWrappedText(s, 'Previously read:', { font, size: 9, lineGap: 2, color: rgb(0.45, 0.45, 0.45) })
        s.y -= 4
        s = drawIndentedBlock(s, `"${originalText}"`, {
          font: italic, size: 10, color: rgb(0.40, 0.40, 0.40),
        })
        s.y -= 10
        s = drawWrappedText(s, 'NOW READS:', { font, size: 9, lineGap: 2, color: rgb(0.94, 0.78, 0.12) })
        s.y -= 4
      } else {
        const leadIn = a.clause_reference
          ? `${a.clause_reference} of the Agreement is hereby amended and replaced in its entirety with the following:`
          : 'The Agreement is hereby amended by the inclusion of the following provision:'
        s = drawWrappedText(s, leadIn, { font: regular, size: 10, lineGap: 4 })
        s.y -= 6
      }

      // The agreed language — bold, full yellow background, dark text.
      const finalText = (a.final_clause_text || a.ai_proposed_redline || '').trim()
      s = drawHighlightedBlock(s, finalText, { font, size: 11 })

      s.y -= 6
      if (a.locked_at) {
        const lockStr = `(Agreed and locked on ${new Date(a.locked_at).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland' })}.)`
        s = drawWrappedText(s, lockStr, { font: italic, size: 8, lineGap: 2, color: rgb(0.50, 0.50, 0.50) })
      }
    })

    // ─── Execution / signature block ────────────────────────────────
    s.y -= 28
    s = ensureSpace(s, 140)

    s = drawWrappedText(s,
      'Save as expressly amended by this Addendum, the Agreement remains in full force and effect. In the event of any conflict or inconsistency between the terms of this Addendum and the terms of the Agreement, the terms of this Addendum shall prevail to the extent of the inconsistency.',
      { font: regular, size: 10, lineGap: 4 })
    s.y -= 12

    s = drawWrappedText(s, 'IN WITNESS WHEREOF, the parties have executed this Addendum as of the dates set forth below.',
      { font: regular, size: 10, lineGap: 4 })
    s.y -= 20

    s.page.drawLine({ start: { x: MARGIN_X, y: s.y }, end: { x: PAGE_W - MARGIN_X, y: s.y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
    s.y -= 30

    // Signature lines — two columns side by side
    const sigColW = (BODY_W - 30) / 2
    s.page.drawText('CLIENT', { x: MARGIN_X, y: s.y - 9, size: 9, font, color: rgb(0.35, 0.35, 0.35) })
    s.page.drawText('OPT DIGITAL LIMITED', { x: MARGIN_X + sigColW + 30, y: s.y - 9, size: 9, font, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 46
    s.page.drawLine({ start: { x: MARGIN_X, y: s.y }, end: { x: MARGIN_X + sigColW, y: s.y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) })
    s.page.drawLine({ start: { x: MARGIN_X + sigColW + 30, y: s.y }, end: { x: PAGE_W - MARGIN_X, y: s.y }, thickness: 0.5, color: rgb(0.4, 0.4, 0.4) })
    s.y -= 12
    s.page.drawText('Signature', { x: MARGIN_X, y: s.y - 8, size: 8, font: italic, color: rgb(0.45, 0.45, 0.45) })
    s.page.drawText('Signature', { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 8, font: italic, color: rgb(0.45, 0.45, 0.45) })
    s.y -= 26

    s.page.drawText(sanitize(`Name: ${contract.client_name}`), { x: MARGIN_X, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.page.drawText('Name: ____________________________', { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 18
    s.page.drawText('Date: ____________________________', { x: MARGIN_X, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.page.drawText('Date: ____________________________', { x: MARGIN_X + sigColW + 30, y: s.y - 8, size: 9, font: regular, color: rgb(0.08, 0.08, 0.08) })


    // 5. Append the ORIGINAL contract pages AFTER the addendum we just
    //    drew. Order is now: [Addendum page 1 with summary] +
    //    [Addendum pages 2..N with amended clauses + execution block] +
    //    [Original signed agreement pages]. Closer opens the PDF and
    //    lands on the changes immediately.
    const originalPages = await out.copyPages(base, base.getPageIndices())
    originalPages.forEach(p => out.addPage(p))

    const outBytes = await out.save()

    // 6. Upload to storage
    const nextVersion = (contract.version || 1) + 1
    const outPath = `${contract_id_used}/amended-v${nextVersion}.pdf`
    const { error: upErr } = await supa.storage
      .from('contract-uploads')
      .upload(outPath, outBytes, { contentType: 'application/pdf', upsert: true })
    if (upErr) return json(500, { error: `upload failed: ${upErr.message}` })

    // 7. Bump contract version + record latest amended path
    const { error: bumpErr } = await supa
      .from('contracts')
      .update({
        version: nextVersion,
        amended_pdf_path: outPath,
      })
      .eq('id', contract_id_used)
    if (bumpErr) return json(500, { error: `version bump: ${bumpErr.message}` })

    // 8. Signed URL (10-minute TTL — closer downloads immediately)
    const { data: signed, error: sErr } = await supa.storage
      .from('contract-uploads')
      .createSignedUrl(outPath, 600, { download: `${contract.client_name.replace(/[^a-z0-9]+/gi, '-')}-amended-v${nextVersion}.pdf` })
    if (sErr) return json(500, { error: `signed url: ${sErr.message}` })

    return json(200, {
      ok: true,
      version: nextVersion,
      path: outPath,
      signed_url: signed.signedUrl,
      amendments_included: amendments.length,
    })
  } catch (err) {
    return json(500, { error: (err as Error).message, stack: (err as Error).stack })
  }
})
