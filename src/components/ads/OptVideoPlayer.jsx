/* OPT-branded video player for the creative-library surface — split out
   of AdsCreativeLibrary.jsx mechanically (step 3 of the library-file
   split). Everything below moved verbatim from the page file; no logic
   changes. Owns the custom <video> chrome (scrubber with comment
   markers, volume, speed menu, fullscreen, keyboard shortcuts), the
   fmtTime formatter, and the stable wrapperStyle constants for the
   360/320 call sites. The page imports OptVideoPlayer / fmtTime /
   OPT_PLAYER_WRAP_360 / OPT_PLAYER_WRAP_320 back from here (the
   submissions/review components use them from the page's module scope).
   ClipEditorModal keeps its own bare <video> — intentionally not this
   player. */
import { useState, useEffect, useRef, useCallback, useImperativeHandle, memo, forwardRef } from 'react'

/* OPT-branded video player. Replaces the native <video controls> on
   the review surface so we can:
   - Put comment markers ON the actual scrubber (not a separate strip
     below the video). The native controls bar wouldn't expose its
     DOM, so we built our own.
   - Apply the editorial design language consistently (yellow accent,
     mono labels, paper-on-black) instead of whatever the browser
     decided to ship.
   - Add Frame.io-style affordances: click anywhere on the scrubber to
     seek, hover the scrubber to preview a time, click a marker to
     jump to that comment's timestamp.

   Public API: pass `src`, an array of `markers` ({ id, ts, color,
   title }), and an `onSeek(seconds)` callback. The player owns its
   <video> ref and surfaces play state + currentTime upward via
   `onState` so the parent's comment composer can stamp "comment at
   N:NN" using the live time.

   Keyboard: space = play/pause, ← / → = ±5s, F = fullscreen. */
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

export const OPT_PLAYER_WRAP_360 = { height: 360, maxHeight: 'min(56vh, 360px)' }
export const OPT_PLAYER_WRAP_320 = { height: 300, maxHeight: 'min(48vh, 320px)' }

// memo-wrapped so SubmissionPreviewModal's 1Hz state ticks don't cascade
// into a player re-render unless an actual prop changes (markers,
// hoveredMarkerId, etc.). All callbacks passed by the parent are
// useCallback-stable; markers is useMemo-stable. Together they let the
// player stay completely idle during normal playback.
export const OptVideoPlayer = memo(forwardRef(function OptVideoPlayer(
  { src, markers = [], onSeek, onState, hoveredMarkerId, onMarkerHoverChange,
    // `compact` switches the player into inline-card mode: no min-height
    // floor, no autoplay (so expanding multiple version cards doesn't
    // dogpile audio), smaller play overlay + tighter controls. Used by
    // SubmissionsPanel so the inline player has the exact same OPT
    // chrome as the Review modal (Ben 2026-06-01: "needs to be pretty
    // congruent across the board").
    compact = false,
    // Outer wrapper styles — lets the caller cap maxHeight in compact
    // mode so the player doesn't push the surrounding card off-screen.
    wrapperStyle,
    autoPlay,
    // 'metadata' (default, cheap) or 'auto' (eager buffer). The detail modal
    // passes 'auto' so a single open clip starts playing fast instead of
    // downloading from zero on the first click. Don't use 'auto' in grids.
    preload = 'metadata',
    // Poster image (thumbnail). Shown while the video loads (so it doesn't
    // flash black) AND blurred + scaled as the backdrop behind a portrait
    // video instead of hard black bars (Ben 2026-06-26).
    poster,
  },
  parentRef,
) {
  const videoRef = useRef(null)
  const wrapRef = useRef(null)
  const scrubberRef = useRef(null)
  // Refs for direct DOM updates on the scrubber + time display. The
  // previous implementation kept currentTime/buffered in React state and
  // setState'd on every video tick (4-30Hz depending on the browser),
  // which re-rendered the whole player tree — markers, tooltips,
  // controls bar — every tick. With ~10 comment markers + a memoized
  // SubmissionPreviewModal still subscribing via onState, the combined
  // cost made the player feel sluggish from the moment the modal opened
  // (Ben 2026-06-01: "everything now is very, very slow, so please
  // review this in depth"). Now: timeupdate writes width/left/textContent
  // directly to these DOM nodes and React never reconciles for time
  // progression. Marker positions depend on duration (not currentTime)
  // so they're stable across ticks.
  const progressFillRef = useRef(null)
  const bufferedFillRef = useRef(null)
  const playheadRef = useRef(null)
  const timeDisplayRef = useRef(null)
  const currentTimeRef = useRef(0)
  const bufferedRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  // Volume 0..1. Stored separately from `muted` so the user can mute
  // (drop audio to 0) and then unmute back to the same level without
  // the slider snapping to 100%. Mirrors the YouTube/Vimeo pattern.
  const [volume, setVolume] = useState(1)
  const [duration, setDuration] = useState(0)
  const [hoverPct, setHoverPct] = useState(null)  // 0..1
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Local marker-hover state — used to show a styled tooltip near the
  // marker. Separate from onMarkerHoverChange because the parent might
  // not care, but the player still wants to render the tooltip.
  const [localHoverMarkerId, setLocalHoverMarkerId] = useState(null)
  // External hover (from the sidebar pointing at this marker) takes
  // precedence over local hover so the marker pulses even without
  // direct mouse-over.
  const effectiveHoverId = hoveredMarkerId ?? localHoverMarkerId

  // Expose play/pause/seek to parent (used by comment markers in the
  // sidebar — clicking a comment seeks the video).
  useImperativeHandle(parentRef, () => ({
    seekTo: (seconds) => {
      const v = videoRef.current
      if (!v) return
      try { v.currentTime = Math.max(0, Math.min(seconds, v.duration || seconds)) } catch {}
      try { v.play() } catch {}
    },
    play: () => { try { videoRef.current?.play() } catch {} },
    pause: () => { try { videoRef.current?.pause() } catch {} },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
  }), [])

  // Push state up to parent. currentTime is NOT pushed on every tick —
  // the parent only needs it to label the "+ Comment at X:XX" button,
  // which can read live time from playerRef.current.getCurrentTime() at
  // click time (and already does — line 2804). We push at 1Hz while
  // playing so any UI that DOES want to display live time can; the
  // button label refreshes once per second which matches the visible
  // resolution of fmtTime anyway. Pushes on play/pause/duration changes
  // happen immediately via the second effect.
  useEffect(() => {
    if (typeof onState !== 'function' || !playing) return
    const i = setInterval(() => {
      onState({
        currentTime: videoRef.current?.currentTime ?? 0,
        duration,
        playing: true,
      })
    }, 1000)
    return () => clearInterval(i)
  }, [playing, duration, onState])
  useEffect(() => {
    if (typeof onState === 'function') {
      onState({ currentTime: videoRef.current?.currentTime ?? 0, duration, playing })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration])

  // Direct-DOM timeupdate handler — replaces setCurrentTime/setBuffered.
  // Reads videoRef once per tick, writes style.width / style.left /
  // textContent directly. No React reconciliation.
  const onVideoTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const t = v.currentTime
    currentTimeRef.current = t
    const d = v.duration && isFinite(v.duration) ? v.duration : duration
    if (d > 0) {
      const pct = (t / d) * 100
      if (progressFillRef.current) progressFillRef.current.style.width = `${pct}%`
      if (playheadRef.current) playheadRef.current.style.left = `${pct}%`
    }
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = `${fmtTime(t)} / ${fmtTime(d)}`
    }
    const b = v.buffered
    if (b && b.length > 0) {
      const bEnd = b.end(b.length - 1)
      bufferedRef.current = bEnd
      if (d > 0 && bufferedFillRef.current) {
        bufferedFillRef.current.style.width = `${Math.min(100, (bEnd / d) * 100)}%`
      }
    }
  }, [duration])

  // Teardown — same cleanup pattern as the rest of the codebase.
  useEffect(() => {
    if (!src) return
    const v = videoRef.current
    return () => {
      if (!v) return
      try { v.pause() } catch {}
      try { v.removeAttribute('src'); v.load() } catch {}
    }
  }, [src])

  // Keyboard shortcuts. Modal-only — when multiple compact inline
  // players are mounted in a SubmissionsPanel (one per expanded
  // version card), a single window-level keydown would dispatch to
  // all of them, e.g. spacebar would play/pause every video at once.
  // The modal is the only context where there's a single, focused
  // player that owns the keyboard.
  useEffect(() => {
    if (compact) return
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const v = videoRef.current
      if (!v) return
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault()
        v.paused ? v.play() : v.pause()
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - (e.key === 'j' ? 10 : 5))
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        e.preventDefault()
        v.currentTime = Math.min(v.duration || 0, v.currentTime + (e.key === 'l' ? 10 : 5))
      } else if (e.key === 'f') {
        e.preventDefault()
        toggleFullscreen()
      } else if (e.key === 'm') {
        e.preventDefault()
        v.muted = !v.muted
        setMuted(v.muted)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact])

  // Fullscreen state sync — the browser can leave fullscreen on Esc
  // without us telling it to, so we need to listen for the change event.
  // Document-level events fire for ANY element entering/exiting
  // fullscreen, including OTHER OptVideoPlayer instances mounted in
  // the same SubmissionsPanel. Without the wrapRef containment check,
  // player A entering fullscreen would flip isFullscreen=true on
  // players B/C/D too (code-review P1, 2026-06-01). Now each player
  // only flips its own state when ITS wrapper is the fullscreen
  // element (or when leaving fullscreen entirely).
  useEffect(() => {
    const onFs = () => {
      const fsEl = document.fullscreenElement
      const isOurs = fsEl === wrapRef.current
      // Update only if this changes OUR state — either we're now
      // fullscreen (fsEl === our wrap) or we're not (anything else).
      setIsFullscreen(prev => isOurs !== prev ? isOurs : prev)
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    if (document.fullscreenElement) {
      try { document.exitFullscreen() } catch {}
    } else {
      try { el.requestFullscreen() } catch {}
    }
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.paused ? v.play() : v.pause()
  }, [])

  // Scrubber interactions. We use pointer events so a click-drag on
  // the bar scrubs smoothly. The scrubber has a generous hit area
  // (12px) but renders as a 4px bar with a 12px thumb on hover.
  const scrubberToSeconds = useCallback((clientX) => {
    const el = scrubberRef.current
    if (!el || !duration) return 0
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return pct * duration
  }, [duration])

  const onScrubberPointerDown = useCallback((e) => {
    e.preventDefault()
    const v = videoRef.current
    if (!v) return
    v.currentTime = scrubberToSeconds(e.clientX)
    const move = (ev) => { v.currentTime = scrubberToSeconds(ev.clientX) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [scrubberToSeconds])

  const onScrubberPointerMove = useCallback((e) => {
    const el = scrubberRef.current
    if (!el || !duration) { setHoverPct(null); return }
    const rect = el.getBoundingClientRect()
    setHoverPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
  }, [duration])

  const onMarkerClick = useCallback((e, marker) => {
    e.stopPropagation()
    if (marker.ts == null) return
    const v = videoRef.current
    if (!v) return
    try { v.currentTime = marker.ts; v.play() } catch {}
    onSeek?.(marker.ts)
  }, [onSeek])

  return (
    <div ref={wrapRef} className="opt-player"
      style={{
        position: 'relative', width: '100%',
        // Hard ceiling so vertical (9:16) submissions can never blow
        // past the viewport even if a caller forgets to pass a
        // height-capped wrapperStyle. Individual call sites can
        // override via wrapperStyle.maxHeight if they want larger.
        maxHeight: 'min(60vh, 520px)',
        background: '#000', color: 'var(--paper)',
        display: 'flex', flexDirection: 'column',
        userSelect: 'none',
        ...wrapperStyle,
      }}>
      {/* Video element with native controls killed. Click toggles
          play/pause; double-click toggles fullscreen. The video FILLS
          the container with object-fit: contain — vertical (9:16)
          videos pillar-box with black bars on the sides, square (1:1)
          videos pillar-box less, horizontal (16:9) fills edge-to-edge.
          Container is flex-grow so it eats every spare vertical pixel
          inside the modal — that's what keeps the player size
          consistent regardless of source aspect ratio (Ben 2026-06-01:
          "make sure that if I'm doing it in a short form, like 9:16,
          it is still going to keep the current size that it has and
          the bars will just be black"). In compact mode (inline card)
          we drop the 400px floor so the player can be ~240px tall
          inside an EditTaskModal submission card. */}
      <div style={{
        flex: '1 1 auto', minHeight: compact ? 0 : 400, position: 'relative',
        background: poster ? 'var(--ink)' : 'linear-gradient(135deg, #23252d 0%, #14151a 60%, #0e0f13 100%)', display: 'flex',
        justifyContent: 'center', alignItems: 'center',
        overflow: 'hidden',
      }}>
        {/* Blurred backdrop — a scaled, blurred copy of the poster fills the
            box so portrait videos sit on a soft blur instead of hard black
            bars (Ben 2026-06-26). */}
        {poster && (
          <div aria-hidden style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${poster})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            filter: 'blur(34px) brightness(0.55) saturate(1.1)',
            transform: 'scale(1.25)',
            pointerEvents: 'none',
          }} />
        )}
        {src ? (
          <video ref={videoRef} src={src} preload={preload} poster={poster || undefined}
            autoPlay={autoPlay !== undefined ? autoPlay : !compact}
            playsInline
            onClick={togglePlay}
            onDoubleClick={toggleFullscreen}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onWaiting={() => { try { if (videoRef.current) videoRef.current.dataset.buffering = '1' } catch {} }}
            onCanPlay={() => { try { if (videoRef.current) videoRef.current.dataset.buffering = '0' } catch {} }}
            onLoadedMetadata={() => {
              const v = videoRef.current
              if (v && isFinite(v.duration)) setDuration(v.duration)
              if (v) {
                setMuted(v.muted)
                setVolume(v.volume)
              }
            }}
            onTimeUpdate={onVideoTimeUpdate}
            onVolumeChange={() => {
              const v = videoRef.current
              if (!v) return
              setMuted(v.muted)
              setVolume(v.volume)
            }}
            onRateChange={() => setPlaybackRate(videoRef.current?.playbackRate ?? 1)}
            style={{
              width: '100%', height: '100%',
              objectFit: 'contain',
              display: 'block', cursor: 'pointer',
              background: 'transparent',
              position: 'relative', zIndex: 1,
            }} />
        ) : (
          <div style={{
            padding: 60, fontFamily: 'var(--mono)', fontSize: 12,
            color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}>No playable file</div>
        )}
        {/* Center play button overlay when paused */}
        {src && !playing && (
          <button onClick={togglePlay} aria-label="Play"
            style={{
              position: 'absolute', inset: 0, margin: 'auto',
              width: compact ? 52 : 76, height: compact ? 52 : 76, borderRadius: '50%',
              background: 'rgba(244,225,74,0.92)',
              border: 'none', cursor: 'pointer',
              color: '#0a0a0a', fontSize: compact ? 20 : 28,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}>▶</button>
        )}
      </div>

      {/* Custom controls bar — onboarding-style: soft top-fading gradient,
          no hard hairline. */}
      <div style={{
        background: 'linear-gradient(to top, rgba(8,10,14,0.97), rgba(8,10,14,0.84))',
        padding: '10px 14px 12px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {/* Scrubber row */}
        <div
          ref={scrubberRef}
          onPointerDown={onScrubberPointerDown}
          onPointerMove={onScrubberPointerMove}
          onPointerLeave={() => setHoverPct(null)}
          style={{
            position: 'relative', height: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center',
          }}>
          {/* Track (background) */}
          <div style={{
            position: 'absolute', left: 0, right: 0, height: 4,
            background: 'rgba(255,255,255,0.15)', borderRadius: 9,
          }} />
          {/* Buffered range — width driven by onVideoTimeUpdate via ref */}
          <div ref={bufferedFillRef} style={{
            position: 'absolute', left: 0, width: '0%',
            height: 4, background: 'rgba(255,255,255,0.35)',
            borderRadius: 9,
          }} />
          {/* Progress fill — width driven by onVideoTimeUpdate via ref */}
          <div ref={progressFillRef} style={{
            position: 'absolute', left: 0, width: '0%',
            height: 4, background: '#f4e14a', borderRadius: 9,
          }} />
          {/* Hover preview marker */}
          {hoverPct != null && (
            <>
              <div style={{
                position: 'absolute', left: `${hoverPct * 100}%`,
                top: -22, transform: 'translateX(-50%)',
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
                background: 'rgba(0,0,0,0.85)', color: 'var(--paper)',
                padding: '2px 6px', borderRadius: 9, whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}>{fmtTime(hoverPct * duration)}</div>
              <div style={{
                position: 'absolute', left: `${hoverPct * 100}%`,
                top: 0, height: 4,
                width: 1, background: 'rgba(255,255,255,0.4)',
                pointerEvents: 'none',
              }} />
            </>
          )}
          {/* Comment markers on the scrubber itself — the killer feature
              over the previous below-video strip. Hover scales the marker
              up and shows a styled tooltip above with author + preview. */}
          {markers.filter(m => m.ts != null && duration > 0).map(m => {
            const left = (m.ts / duration) * 100
            const color = m.color || '#f4e14a'
            const isHovered = effectiveHoverId === m.id
            return (
              <div key={m.id}
                onClick={(e) => onMarkerClick(e, m)}
                onMouseEnter={() => {
                  setLocalHoverMarkerId(m.id)
                  onMarkerHoverChange?.(m.id)
                }}
                onMouseLeave={() => {
                  setLocalHoverMarkerId(null)
                  onMarkerHoverChange?.(null)
                }}
                style={{
                  position: 'absolute', left: `${left}%`,
                  top: isHovered ? -6 : -4, transform: 'translateX(-50%)',
                  width: isHovered ? 16 : 12,
                  height: isHovered ? 16 : 12,
                  borderRadius: '50%',
                  background: color, border: '2px solid #0a0a0a',
                  cursor: 'pointer', zIndex: 2,
                  boxShadow: isHovered
                    ? '0 0 0 4px rgba(244,225,74,0.25), 0 1px 3px rgba(0,0,0,0.5)'
                    : '0 1px 3px rgba(0,0,0,0.5)',
                  transition: 'all 120ms ease',
                }} />
            )
          })}
          {/* Custom marker tooltip — replaces the native title attr
              (which has 1+ second delay and unstyled). Renders above
              the scrubber when a marker is being hovered (locally OR
              via the sidebar). Pointer-events: none so it never
              blocks marker clicks. */}
          {effectiveHoverId != null && (() => {
            const m = markers.find(x => x.id === effectiveHoverId)
            if (!m || m.ts == null || duration <= 0) return null
            const left = Math.max(8, Math.min(92, (m.ts / duration) * 100))
            return (
              <div style={{
                position: 'absolute', left: `${left}%`,
                bottom: 22, transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.92)',
                color: 'white', padding: '8px 10px',
                fontFamily: 'var(--sans)', fontSize: 12,
                maxWidth: 280, minWidth: 160,
                lineHeight: 1.4, pointerEvents: 'none',
                border: '1px solid rgba(244,225,74,0.4)',
                boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
                zIndex: 5,
                animation: 'optTooltipIn 80ms ease-out',
              }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 700,
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: '#f4e14a', marginBottom: 4,
                }}>{m.authorName ? `${m.authorName} · ${fmtTime(m.ts)}` : fmtTime(m.ts)}</div>
                <div style={{
                  whiteSpace: 'normal', wordBreak: 'break-word',
                  maxHeight: 80, overflow: 'hidden',
                }}>{(m.title || '').slice(0, 240)}</div>
              </div>
            )
          })()}
          {/* Playhead thumb — left driven by onVideoTimeUpdate via ref */}
          <div ref={playheadRef} style={{
            position: 'absolute', left: '0%',
            width: 12, height: 12, borderRadius: '50%',
            background: '#f4e14a', transform: 'translateX(-50%)',
            boxShadow: '0 2px 6px rgba(244,225,74,0.5)',
            pointerEvents: 'none',
          }} />
        </div>

        {/* Buttons row */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          fontFamily: 'var(--mono)', fontSize: 11,
        }}>
          <button onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'white', fontSize: 16, padding: '0 2px',
              minWidth: 18,
            }}>{playing ? '⏸' : '▶'}</button>
          {/* Mute + volume slider — clicking the speaker toggles mute
              while preserving the slider's last value (YouTube-style).
              Dragging the slider sets volume, auto-unmutes when the
              user nudges it above 0, auto-mutes at exactly 0. Speaker
              icon reflects level so the visual matches the audio. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => {
                const v = videoRef.current
                if (!v) return
                // Silent-unmute guard: if the slider was dragged to 0
                // (which auto-mutes), clicking the speaker would
                // otherwise unmute a volume=0 track — visually
                // appears playing but no sound (code-review P0,
                // 2026-06-01). When unmuting from volume=0, bump
                // back to 0.5 so the user actually hears audio.
                if (v.muted && v.volume === 0) {
                  v.volume = 0.5
                  setVolume(0.5)
                }
                v.muted = !v.muted
                setMuted(v.muted)
              }}
              aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'white', fontSize: 14, padding: '0 2px',
                minWidth: 18,
              }}>{muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}</button>
            <input
              type="range" min="0" max="1" step="0.01"
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = videoRef.current
                if (!v) return
                const newVol = parseFloat(e.target.value)
                v.volume = newVol
                v.muted = newVol === 0
                // onVolumeChange handler syncs state, but set explicitly
                // here too so the slider stays in sync even if the
                // browser doesn't fire the event (some Safari versions).
                setVolume(newVol)
                setMuted(newVol === 0)
              }}
              aria-label="Volume"
              style={{
                width: compact ? 56 : 72,
                accentColor: '#f4e14a',
                cursor: 'pointer',
                verticalAlign: 'middle',
              }}
            />
          </div>
          {/* Read currentTime from ref so re-renders (play/pause/hover)
              don't clobber the live textContent written by
              onVideoTimeUpdate. Ref read at render time → React writes
              the latest known time; next tick writes the next. They
              converge without flashing back to 0:00. */}
          <span ref={timeDisplayRef}
            style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
            {fmtTime(currentTimeRef.current)} / {fmtTime(duration)}
          </span>
          <span style={{ flex: 1 }} />
          {/* Playback rate — custom popup. Native <select> renders OS-
              level dropdowns we can't style, which gave a white-on-white
              option list in dark mode and unreadable contrast (Ben
              2026-06-01). */}
          <OptSpeedMenu value={playbackRate} onChange={(r) => {
            const v = videoRef.current
            if (v) { v.playbackRate = r; setPlaybackRate(r) }
          }} />
          <button onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title="F — fullscreen"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'white', fontSize: 14, padding: '0 4px',
              minWidth: 18,
            }}>{isFullscreen ? '⤡' : '⛶'}</button>
        </div>
      </div>
      <style>{`
        @keyframes optTooltipIn {
          from { opacity: 0; transform: translate(-50%, 4px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes optSlideInUp {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes optPulse {
          0%   { box-shadow: 0 0 0 0 rgba(244,225,74,0.5); }
          70%  { box-shadow: 0 0 0 8px rgba(244,225,74,0); }
          100% { box-shadow: 0 0 0 0 rgba(244,225,74,0); }
        }
      `}</style>
    </div>
  )
}))

// Custom playback-speed picker. Renders the current speed as a small
// pill; click opens a styled popup with the rate options. Replaces the
// native <select> which had OS-default styling we couldn't override.
function OptSpeedMenu({ value, onChange }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          background: 'rgba(255,255,255,0.1)', color: 'var(--paper)',
          border: '1px solid rgba(255,255,255,0.18)',
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700,
          padding: '3px 9px', cursor: 'pointer', outline: 'none',
          letterSpacing: '0.04em', minWidth: 38,
          transition: 'background 120ms ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}>
        {value}×
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
          <div style={{
            position: 'absolute', right: 0, bottom: 'calc(100% + 6px)',
            background: 'rgba(15,15,15,0.97)',
            border: '1px solid rgba(255,255,255,0.18)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
            display: 'flex', flexDirection: 'column',
            minWidth: 70, zIndex: 101,
            animation: 'optSlideInUp 100ms ease-out',
          }}>
            {PLAYBACK_RATES.map(r => {
              const active = r === value
              return (
                <button key={r}
                  onClick={() => { onChange(r); setOpen(false) }}
                  style={{
                    background: active ? '#f4e14a' : 'transparent',
                    color: active ? '#0a0a0a' : 'white',
                    border: 'none',
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                    padding: '7px 12px', cursor: 'pointer',
                    textAlign: 'right',
                    letterSpacing: '0.04em',
                  }}
                  onMouseEnter={e => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.1)'
                  }}
                  onMouseLeave={e => {
                    if (!active) e.currentTarget.style.background = 'transparent'
                  }}>
                  {r}×
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// Format seconds as M:SS or H:MM:SS.
export function fmtTime(seconds) {
  if (seconds == null || !isFinite(seconds)) return '0:00'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`
}
