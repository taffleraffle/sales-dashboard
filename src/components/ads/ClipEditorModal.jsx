import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from '../editorial/Modal'
import { Button } from '../editorial/atoms'
// Server-side engine (clip-worker / real ffmpeg) — same signatures as the
// old browser clipSurgery, so this is a drop-in swap. Handles iPhone HEVC,
// no 32MB browser download, scene-cut detection. QA-verified 2026-06-14.
import { detectTakeBoundaries, renderSegment, renderMerge, MAX_INPUT_BYTES } from '../../services/clipServer'

/*
  Clip Editor — cut / trim / merge at upload time (Ben, 2026-06-12:
  "almost act like an editor where I can cut them, clip them, and merge
  them. There needs to be review.").

  Model: every source file is divided into SEGMENTS by cut points; each
  segment has draggable in/out trim handles (shave the stuttered first
  second of a take) and belongs to one of two bins:

    separate → renders as its own clip (hook takes)
    merge    → joins the ordered merge track into ONE MP4 (body parts)

  Review without rendering: click a segment to play exactly that range;
  "Preview result" chains the merge track playlist-style so the joins
  are audible before any rendering happens.

  Render rules live in services/clipSurgery.js — lossless stream-copy
  whenever nothing is trimmed, frame-accurate re-encode when handles
  were moved (stream-copy cuts snap to keyframes and would reintroduce
  the stutter being trimmed).
*/

const fmtT = (s) => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`
}

const baseName = (name) => (name || 'clip').replace(/\.[^.]+$/, '')

let SEG_SEQ = 1

export default function ClipEditorModal({
  items,            // [{ file }] — the upload-modal items handed in
  mode = 'split',   // 'split' (single file) | 'merge' (multi-select)
  onClose,
  onDone,           // ({ results: [{file, note, typeOverride, keepName}], sourceNotes: Map<File, note> })
}) {
  const files = useMemo(() => items.map(i => i.file), [items])
  const videoRef = useRef(null)
  const stripRef = useRef(null)

  // Per-file durations. Seeded from the upload modal's probe
  // (item.dims.duration_s) so segments exist for EVERY file immediately
  // — without this, files never opened in the tab bar never seeded a
  // segment and silently dropped out of merges. onLoadedMetadata then
  // refines with the player's exact value.
  const [durations, setDurations] = useState(() => {
    const d = {}
    items.forEach((it, idx) => {
      if (it.dims?.duration_s) d[idx] = it.dims.duration_s
    })
    return d
  })
  const blobUrls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files])
  useEffect(() => () => { blobUrls.forEach(u => URL.revokeObjectURL(u)) }, [blobUrls])

  // The active file shown in the player/timeline.
  const [activeIdx, setActiveIdx] = useState(0)
  const [currentT, setCurrentT] = useState(0)

  // Segments across ALL files. {id, fileIdx, in, out, precise, bin}
  // precise=true once a trim handle moved → that segment re-encodes.
  const [segments, setSegments] = useState([])
  const [mergeOrder, setMergeOrder] = useState([])   // segment ids, ordered
  const [busyMsg, setBusyMsg] = useState(null)
  const [progress, setProgress] = useState(null)
  const [err, setErr] = useState(null)
  const [outName, setOutName] = useState(
    `JOINED-${baseName(files[0]?.name)}-MERGED.mp4`
  )

  // Segment preview stop point (seconds) — timeupdate pauses there.
  const previewStopRef = useRef(null)
  // Playlist preview state: ordered [{fileIdx, in, out}] still to play.
  const playlistRef = useRef(null)

  const totalBytes = files.reduce((s, f) => s + f.size, 0)
  const overBudget = totalBytes > MAX_INPUT_BYTES

  // Seed one whole-file segment per file once its duration is known.
  useEffect(() => {
    setSegments(curr => {
      const have = new Set(curr.map(s => s.fileIdx))
      const next = [...curr]
      files.forEach((f, idx) => {
        const dur = durations[idx]
        if (dur && !have.has(idx)) {
          next.push({ id: SEG_SEQ++, fileIdx: idx, in: 0, out: dur, precise: false, bin: mode === 'merge' ? 'merge' : 'separate' })
        }
      })
      return next
    })
  }, [durations, files, mode])
  useEffect(() => {
    // Keep merge order in sync as segments appear/disappear.
    setMergeOrder(curr => {
      const mergeIds = segments.filter(s => s.bin === 'merge').map(s => s.id)
      const kept = curr.filter(id => mergeIds.includes(id))
      const added = mergeIds.filter(id => !kept.includes(id))
      return [...kept, ...added]
    })
  }, [segments])

  const activeDur = durations[activeIdx] || 0
  const activeSegs = segments
    .filter(s => s.fileIdx === activeIdx)
    .sort((a, b) => a.in - b.in)

  // ── player events ────────────────────────────────────────────────────
  // Seek queued for after a src swap — applying currentTime before
  // metadata loads is dropped by some browsers (the old blind 250ms
  // timeout previewed the wrong span on slow-loading files).
  const pendingSpanRef = useRef(null)
  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    setDurations(d => (d[activeIdx] ? d : { ...d, [activeIdx]: v.duration }))
    const pending = pendingSpanRef.current
    if (pending && pending.fileIdx === activeIdx) {
      pendingSpanRef.current = null
      previewStopRef.current = pending.t1
      v.currentTime = pending.t0
      v.play().catch(() => {})
    }
  }
  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    setCurrentT(v.currentTime)
    if (previewStopRef.current != null && v.currentTime >= previewStopRef.current - 0.04) {
      previewStopRef.current = null
      const pl = playlistRef.current
      if (pl && pl.length) {
        const next = pl.shift()
        playSpan(next.fileIdx, next.in, next.out)
      } else {
        v.pause()
        playlistRef.current = null
      }
    }
  }

  const playSpan = useCallback((fileIdx, t0, t1) => {
    const v = videoRef.current
    if (!v) return
    if (fileIdx !== activeIdx) {
      // src swap → onLoadedMetadata applies the seek once it's safe.
      pendingSpanRef.current = { fileIdx, t0, t1 }
      setActiveIdx(fileIdx)
    } else {
      pendingSpanRef.current = null
      previewStopRef.current = t1
      v.currentTime = t0
      v.play().catch(() => {})
    }
  }, [activeIdx])

  // Click anywhere on the timeline strip to move the playhead there
  // (the native video bar is tiny; this is the real scrubber). Ignores
  // clicks that land on a trim handle (those stopPropagation).
  const seekStrip = (e) => {
    const strip = stripRef.current
    const v = videoRef.current
    if (!strip || !v || !activeDur) return
    const rect = strip.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t = frac * activeDur
    v.currentTime = t
    setCurrentT(t)
    previewStopRef.current = null   // a manual seek cancels any preview-stop
  }

  // ── segment operations ───────────────────────────────────────────────
  const cutAtPlayhead = () => {
    const t = currentT
    let newPair = null   // [leftId, rightId] when a merge-bin segment split
    setSegments(curr => curr.flatMap(s => {
      if (s.fileIdx !== activeIdx || t <= s.in + 0.2 || t >= s.out - 0.2) return [s]
      const right = { id: SEG_SEQ++, fileIdx: s.fileIdx, in: t, out: s.out, precise: s.precise, bin: s.bin }
      if (s.bin === 'merge') newPair = [s.id, right.id]
      return [{ ...s, out: t }, right]
    }))
    // Keep the new right half ADJACENT to its left half in the merge
    // order — the sync effect would otherwise append it at the end and
    // the merged output would play it after everything else.
    if (newPair) {
      setMergeOrder(o => {
        const i = o.indexOf(newPair[0])
        if (i < 0) return o
        const n = [...o]
        n.splice(i + 1, 0, newPair[1])
        return n
      })
    }
  }

  const autoDetect = async () => {
    setErr(null)
    setBusyMsg('Detecting takes…')
    try {
      const cuts = await detectTakeBoundaries(files[activeIdx], { onStage: setBusyMsg })
      if (!cuts.length) {
        setErr('No take boundaries detected — no scene cuts or silence gaps found. Use "Cut at playhead" to split manually.')
      } else {
        setSegments(curr => {
          const others = curr.filter(s => s.fileIdx !== activeIdx)
          const dur = durations[activeIdx]
          const bounds = [0, ...cuts.sort((a, b) => a - b), dur]
          const segs = []
          for (let i = 0; i < bounds.length - 1; i++) {
            segs.push({ id: SEG_SEQ++, fileIdx: activeIdx, in: bounds[i], out: bounds[i + 1], precise: false, bin: mode === 'merge' ? 'merge' : 'separate' })
          }
          return [...others, ...segs]
        })
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusyMsg(null)
    }
  }

  const removeSegment = (id) => setSegments(curr => {
    const victim = curr.find(s => s.id === id)
    if (!victim) return curr
    const siblings = curr.filter(s => s.fileIdx === victim.fileIdx && s.id !== id).sort((a, b) => a.in - b.in)
    if (!siblings.length) return curr  // never delete the last segment of a file
    // Fold the gap into a neighbour so no footage vanishes from the
    // timeline — built as NEW objects (mutating state objects in place
    // leaks the change into closures still holding the old array).
    const prev = [...siblings].reverse().find(s => s.out <= victim.in + 0.01)
    const next = !prev ? siblings.find(s => s.in >= victim.out - 0.01) : null
    return curr
      .filter(s => s.id !== id)
      .map(s => {
        if (prev && s.id === prev.id) return { ...s, out: victim.out }
        if (next && s.id === next.id) return { ...s, in: victim.in }
        return s
      })
  })

  const setBin = (id, bin) => setSegments(curr => curr.map(s => s.id === id ? { ...s, bin } : s))
  const nudgeTrim = (id, edge, delta) => setSegments(curr => curr.map(s => {
    if (s.id !== id) return s
    if (edge === 'in') {
      const v = Math.max(0, Math.min(s.out - 0.3, s.in + delta))
      return { ...s, in: v, precise: true }
    }
    const v = Math.min(durations[s.fileIdx] || s.out, Math.max(s.in + 0.3, s.out + delta))
    return { ...s, out: v, precise: true }
  }))

  // Drag a trim handle on the strip.
  const dragHandle = (segId, edge) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    const strip = stripRef.current
    if (!strip || !activeDur) return
    const rect = strip.getBoundingClientRect()
    const move = (ev) => {
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      const t = frac * activeDur
      setSegments(curr => curr.map(s => {
        if (s.id !== segId) return s
        if (edge === 'in') return { ...s, in: Math.min(t, s.out - 0.3), precise: true }
        return { ...s, out: Math.max(t, s.in + 0.3), precise: true }
      }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ── preview result ───────────────────────────────────────────────────
  const previewResult = () => {
    const ordered = mode === 'merge'
      ? mergeOrder.map(id => segments.find(s => s.id === id)).filter(Boolean)
      : segments.filter(s => s.bin === 'separate').sort((a, b) => a.fileIdx - b.fileIdx || a.in - b.in)
    if (!ordered.length) return
    playlistRef.current = ordered.slice(1).map(s => ({ fileIdx: s.fileIdx, in: s.in, out: s.out }))
    playSpan(ordered[0].fileIdx, ordered[0].in, ordered[0].out)
  }

  // ── render + hand back ───────────────────────────────────────────────
  const renderAll = async () => {
    setErr(null)
    setProgress(0)
    const results = []
    const sourceNotes = new Map()
    try {
      const mergeSegs = mergeOrder.map(id => segments.find(s => s.id === id)).filter(Boolean)
      const sepSegs = segments.filter(s => s.bin === 'separate').sort((a, b) => a.fileIdx - b.fileIdx || a.in - b.in)

      // A single segment on the merge track is a mistake we must not
      // silently discard while other work renders successfully.
      if (mergeSegs.length === 1) {
        setErr('One segment sits alone on the merge track — add another to merge, or switch it back to "separate clip".')
        setBusyMsg(null); setProgress(null)
        return
      }

      if (mergeSegs.length >= 2) {
        setBusyMsg('Rendering merged clip…')
        const dur = (idx) => durations[idx] || Infinity
        const parts = mergeSegs.map(s => ({
          file: files[s.fileIdx],
          start: s.in > 0.05 ? s.in : null,
          end: s.out < dur(s.fileIdx) - 0.05 ? s.out : null,
          trimmed: s.precise,
          dims: items[s.fileIdx]?.dims || null,
        }))
        const merged = await renderMerge(parts, {
          outName,
          onStage: setBusyMsg,
          onProgress: setProgress,
        })
        const partNames = mergeSegs.map((s, i) => `part ${i + 1}: ${files[s.fileIdx].name} ${fmtT(s.in)}–${fmtT(s.out)}`)
        results.push({
          file: merged,
          typeOverride: 'Body',
          keepName: true,
          note: `Merged in the upload Clip Editor from ${partNames.join('; ')}.`,
        })
        mergeSegs.forEach(s => sourceNotes.set(files[s.fileIdx], `Source part of "${outName}" (kept for reference).`))
      }

      let hookN = 0
      for (const s of sepSegs) {
        // A lone untouched whole-file segment isn't an edit — skip it
        // (the file uploads as-is through the normal path).
        const dur = durations[s.fileIdx] || 0
        const whole = s.in < 0.05 && s.out > dur - 0.05
        const onlySegOfFile = segments.filter(x => x.fileIdx === s.fileIdx).length === 1
        if (whole && onlySegOfFile) continue
        hookN++
        setBusyMsg(`Rendering take ${hookN}…`)
        const f = await renderSegment(files[s.fileIdx], {
          start: s.in > 0.05 ? s.in : null,
          end: s.out < dur - 0.05 ? s.out : null,
          reencode: s.precise,
          outName: `${baseName(files[s.fileIdx].name)}-HOOK${String(hookN).padStart(2, '0')}.mp4`,
          onStage: setBusyMsg,
          onProgress: setProgress,
        })
        results.push({
          file: f,
          typeOverride: 'Hook',
          keepName: true,
          note: `Take ${hookN} cut from ${files[s.fileIdx].name} (${fmtT(s.in)}–${fmtT(s.out)}) in the upload Clip Editor.`,
        })
        sourceNotes.set(files[s.fileIdx], 'Uncut multi-take source (kept for reference) — takes were split in the upload Clip Editor.')
      }

      if (!results.length) {
        setErr('Nothing to render yet — cut the file into takes, trim something, or put 2+ segments on the merge track.')
        setBusyMsg(null); setProgress(null)
        return
      }
      onDone({ results, sourceNotes })
    } catch (e) {
      setErr(e.message || 'Render failed')
      setBusyMsg(null)
      setProgress(null)
    }
  }

  const mergeCount = segments.filter(s => s.bin === 'merge').length
  const busy = busyMsg !== null

  return (
    <Modal open onClose={busy ? () => {} : onClose} size="xl"
      eyebrow="Clip editor"
      title={mode === 'merge' ? `Merge ${files.length} files` : baseName(files[0]?.name)}
      subtitle="Cut takes, drag the handles to trim stutters, preview, then render. Originals are kept."
      footer={
        <>
          {err && <span style={{ color: '#b53e3e', fontSize: 12, marginRight: 'auto', maxWidth: 480 }}>{err}</span>}
          {busy && (
            <span style={{ marginRight: 'auto', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
              {busyMsg}{progress != null ? ` ${Math.round(progress * 100)}%` : ''}
            </span>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="ghost" onClick={previewResult} disabled={busy || !segments.length}>▶ Preview result</Button>
          <Button variant="primary" onClick={renderAll} disabled={busy || overBudget}>
            {mergeCount >= 2 ? 'Render & add to upload' : 'Render takes & add to upload'}
          </Button>
        </>
      }>
      <div style={{ padding: '18px 24px', display: 'grid', gap: 14 }}>
        {overBudget && (
          <div style={{
            padding: '10px 14px', background: 'rgba(181,62,62,0.08)',
            border: '1px solid rgba(181,62,62,0.35)', borderLeft: '3px solid #b53e3e',
            fontFamily: 'var(--mono)', fontSize: 11.5, color: '#b53e3e',
          }}>
            {Math.round(totalBytes / 1024 / 1024)}MB selected — the editor handles up to {Math.round(MAX_INPUT_BYTES / 1024 / 1024)}MB at once. Remove some files.
          </div>
        )}

        {/* File tabs (merge mode juggles several sources) */}
        {files.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {files.map((f, i) => (
              <button key={i} type="button" onClick={() => setActiveIdx(i)} style={{
                padding: '5px 10px', fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
                background: i === activeIdx ? 'var(--ink)' : 'var(--paper)',
                color: i === activeIdx ? 'var(--paper)' : 'var(--ink-2)',
                border: '1px solid var(--rule)', cursor: 'pointer',
                maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{f.name}</button>
            ))}
          </div>
        )}

        {/* Player */}
        <div style={{ background: '#000', border: '1px solid var(--rule)' }}>
          <video ref={videoRef} src={blobUrls[activeIdx]} controls playsInline
            onLoadedMetadata={onLoadedMetadata} onTimeUpdate={onTimeUpdate}
            style={{ width: '100%', maxHeight: 'min(46vh, 420px)', display: 'block' }} />
        </div>

        {/* Timeline strip — segments + draggable trim handles */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              Timeline · {fmtT(currentT)} / {fmtT(activeDur)}
            </span>
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="secondary" onClick={autoDetect} disabled={busy || !activeDur}>✨ Auto-detect takes</Button>
            <Button size="sm" variant="secondary" onClick={cutAtPlayhead} disabled={busy || !activeDur}>✂ Cut at playhead</Button>
          </div>
          <div ref={stripRef} onClick={seekStrip}
            title="Click to move the playhead here, then ‘Cut at playhead’"
            style={{ position: 'relative', height: 54, background: 'var(--paper-2)', border: '1px solid var(--rule)', userSelect: 'none', cursor: 'text' }}>
            {activeDur > 0 && activeSegs.map((s, i) => {
              const l = (s.in / activeDur) * 100
              const w = ((s.out - s.in) / activeDur) * 100
              return (
                <div key={s.id}
                  onClick={seekStrip}
                  title={`Segment ${i + 1}: ${fmtT(s.in)}–${fmtT(s.out)} · click to move the playhead here (▶ preview is in the list below)`}
                  style={{
                    position: 'absolute', top: 6, bottom: 6,
                    left: `${l}%`, width: `${w}%`,
                    background: s.bin === 'merge' ? 'rgba(184,106,12,0.25)' : 'rgba(62,126,186,0.22)',
                    border: `1.5px solid ${s.bin === 'merge' ? '#b86a0c' : '#3e7eba'}`,
                    cursor: 'text', overflow: 'hidden',
                  }}>
                  <span style={{
                    position: 'absolute', top: 2, left: 12, right: 12,
                    fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700,
                    color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {i + 1}{s.precise ? ' ·trim' : ''}
                  </span>
                  {/* trim handles — onClick stops the strip seek */}
                  <div onPointerDown={dragHandle(s.id, 'in')} onClick={e => e.stopPropagation()} title="Drag to trim the start"
                    style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: 'rgba(10,10,10,0.35)' }} />
                  <div onPointerDown={dragHandle(s.id, 'out')} onClick={e => e.stopPropagation()} title="Drag to trim the end"
                    style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', background: 'rgba(10,10,10,0.35)' }} />
                </div>
              )
            })}
            {/* playhead */}
            {activeDur > 0 && (
              <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: 'var(--accent)', left: `${(currentT / activeDur) * 100}%` }} />
            )}
          </div>
        </div>

        {/* Segment list — sorted COPY (in-place sort would mutate state
            during render); take numbers count separate-bin segments only
            so they match the -HOOKnn names renderAll produces. */}
        <div style={{ display: 'grid', gap: 6 }}>
          {(() => { let takeN = 0; return [...segments].sort((a, b) => a.fileIdx - b.fileIdx || a.in - b.in).map((s) => {
            if (s.bin === 'separate') takeN++
            const takeLabel = takeN
            return (
            <div key={s.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 10px', background: 'var(--paper)', border: '1px solid var(--rule)',
              fontFamily: 'var(--mono)', fontSize: 11,
            }}>
              <span style={{ fontWeight: 700, color: s.bin === 'merge' ? '#b86a0c' : '#3e7eba', minWidth: 60 }}>
                {s.bin === 'merge' ? `merge #${mergeOrder.indexOf(s.id) + 1}` : `take ${takeLabel}`}
              </span>
              {files.length > 1 && <span style={{ color: 'var(--ink-4)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{files[s.fileIdx].name}</span>}
              <span style={{ color: 'var(--ink-3)' }}>{fmtT(s.in)} – {fmtT(s.out)}</span>
              {s.precise && <span style={{ color: '#b86a0c', fontSize: 9.5 }}>FRAME-ACCURATE</span>}
              <button type="button" onClick={() => nudgeTrim(s.id, 'in', +0.1)} title="Trim 0.1s off the start" style={nudgeBtn}>+0.1s in</button>
              <button type="button" onClick={() => nudgeTrim(s.id, 'in', -0.1)} title="Extend the start by 0.1s" style={nudgeBtn}>−0.1s in</button>
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => playSpan(s.fileIdx, s.in, s.out)} style={nudgeBtn}>▶ preview</button>
              <button type="button" onClick={() => setBin(s.id, s.bin === 'merge' ? 'separate' : 'merge')} style={nudgeBtn}>
                {s.bin === 'merge' ? '→ separate clip' : '→ merge track'}
              </button>
              {s.bin === 'merge' && (
                <>
                  <button type="button" style={nudgeBtn} title="Earlier in the merge"
                    onClick={() => setMergeOrder(o => { const i2 = o.indexOf(s.id); if (i2 <= 0) return o; const n = [...o]; [n[i2 - 1], n[i2]] = [n[i2], n[i2 - 1]]; return n })}>↑</button>
                  <button type="button" style={nudgeBtn} title="Later in the merge"
                    onClick={() => setMergeOrder(o => { const i2 = o.indexOf(s.id); if (i2 < 0 || i2 >= o.length - 1) return o; const n = [...o]; [n[i2 + 1], n[i2]] = [n[i2], n[i2 + 1]]; return n })}>↓</button>
                </>
              )}
              <button type="button" onClick={() => removeSegment(s.id)} title="Remove this cut (footage rejoins its neighbour)" style={{ ...nudgeBtn, color: '#b53e3e' }}>✕</button>
            </div>
            )
          }) })()}
        </div>

        {/* Merge output name */}
        {mergeCount >= 2 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>Merged file name</span>
            <input type="text" value={outName} onChange={e => setOutName(e.target.value)}
              style={{ flex: 1, maxWidth: 420, padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 12, border: '1px solid var(--rule)', background: 'var(--paper)', outline: 'none' }} />
          </div>
        )}
      </div>
    </Modal>
  )
}

const nudgeBtn = {
  padding: '3px 7px', fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600,
  background: 'transparent', color: 'var(--ink-2)',
  border: '1px solid var(--rule)', borderRadius: 9, cursor: 'pointer',
  whiteSpace: 'nowrap',
}
