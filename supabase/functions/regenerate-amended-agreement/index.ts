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

    // 4. Build addendum pages
    const font     = await base.embedFont(StandardFonts.HelveticaBold)
    const regular  = await base.embedFont(StandardFonts.Helvetica)
    const italic   = await base.embedFont(StandardFonts.HelveticaOblique)

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
      const page = base.addPage([PAGE_W, PAGE_H])
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

    let s = newPage()

    // Cover header
    s.page.drawText('AMENDMENT ADDENDUM', { x: MARGIN_X, y: s.y - 22, size: 22, font, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 32
    s.page.drawText('Opt Digital Limited', { x: MARGIN_X, y: s.y - 12, size: 11, font: regular, color: rgb(0.35, 0.35, 0.35) })
    s.y -= 24

    const dateStr = new Date().toLocaleDateString('en-NZ', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Pacific/Auckland',
    })
    const introLines = [
      `This Amendment Addendum is incorporated into and forms part of the Client Form and Client Terms (the "Agreement") between Opt Digital Limited and ${contract.client_name}${contract.client_company ? ' (' + contract.client_company + ')' : ''}.`,
      `Template: ${templateKey === 'retainer' ? 'Local Surge — Work For Free Until We Do (90-day retainer)' : 'Local Surge Offer — 14-day Trial ($997)'}.`,
      `Date of Addendum: ${dateStr}. Contract version: v${(contract.version || 1) + 1}.`,
      `The following amendments have been negotiated between the parties and have been agreed by Opt Digital Limited via the OPT amendment-review process. The original Agreement remains in effect as printed, save where expressly modified by the clauses set out below. In the event of any conflict between the original Agreement and this Addendum, the language in this Addendum shall prevail.`,
    ]
    for (const p of introLines) {
      s = drawWrappedText(s, p, { font: regular, size: 10, lineGap: 4 })
      s.y -= 8
    }

    // Each amendment
    amendments.forEach((a, idx) => {
      s.y -= 8
      s = ensureSpace(s, 60)
      s.page.drawText(sanitize(`Clause ${idx + 1}${a.clause_reference ? ' -- ' + a.clause_reference : ''}`), {
        x: MARGIN_X, y: s.y - 13, size: 13, font, color: rgb(0.08, 0.08, 0.08),
      })
      s.y -= 22

      s = drawWrappedText(s, 'Client request:', { font, size: 9, lineGap: 2, color: rgb(0.35, 0.35, 0.35) })
      s.y -= 2
      s = drawWrappedText(s, a.requested_change, { font: italic, size: 10, lineGap: 4 })
      s.y -= 8

      const finalText = a.final_clause_text || a.ai_proposed_redline || ''
      if (finalText.trim()) {
        s = drawWrappedText(s, 'Agreed clause language:', { font, size: 9, lineGap: 2, color: rgb(0.35, 0.35, 0.35) })
        s.y -= 2
        s = drawWrappedText(s, finalText, { font: regular, size: 10, lineGap: 4 })
      } else {
        s = drawWrappedText(s, 'Resolution:', { font, size: 9, lineGap: 2, color: rgb(0.35, 0.35, 0.35) })
        s.y -= 2
        const verdictLabel =
          a.ai_verdict === 'allow'  ? 'Approved per OPT policy.' :
          a.ai_verdict === 'reject' ? 'Declined per OPT policy.' :
                                       'Escalated to Opt Digital management for review.'
        s = drawWrappedText(s, verdictLabel + ' Refer to the amendment review thread for the full negotiated position.',
          { font: regular, size: 10, lineGap: 4 })
      }
      s.y -= 6
      if (a.locked_at) {
        const lockStr = `Locked in on ${new Date(a.locked_at).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })}.`
        s = drawWrappedText(s, lockStr, { font: italic, size: 8, lineGap: 2, color: rgb(0.45, 0.45, 0.45) })
      }
    })

    // Signature block
    s.y -= 24
    s = ensureSpace(s, 100)
    s.page.drawLine({ start: { x: MARGIN_X, y: s.y }, end: { x: PAGE_W - MARGIN_X, y: s.y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) })
    s.y -= 18
    s.page.drawText('Executed as an amendment to the Agreement on _________________ (insert date the final party signs).',
      { x: MARGIN_X, y: s.y - 10, size: 10, font: regular, color: rgb(0.08, 0.08, 0.08) })
    s.y -= 50
    s.page.drawText('Client signature: _____________________________', { x: MARGIN_X, y: s.y - 10, size: 10, font: regular })
    s.y -= 30
    s.page.drawText('Opt Digital Limited: _____________________________', { x: MARGIN_X, y: s.y - 10, size: 10, font: regular })

    // 5. Save merged PDF (base + addendum pages)
    const outBytes = await base.save()

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
