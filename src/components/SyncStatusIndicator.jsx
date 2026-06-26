import { useState, useRef, useEffect } from 'react'
import { RefreshCw, Check, Clock, AlertTriangle } from 'lucide-react'
import { getAllSyncStatus, runAutoSync, subscribeSyncStatus } from '../services/autoSync'
import { ICON } from '../utils/constants'
import { useToast } from '../hooks/useToast'

function formatAge(ms) {
  if (ms === null || ms === undefined) return 'never'
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function SyncStatusIndicator({ pinned = ['meta', 'marketingTracker'] }) {
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const ref = useRef(null)
  const toast = useToast()

  useEffect(() => {
    const unsub = subscribeSyncStatus(() => setTick(t => t + 1))
    const interval = setInterval(() => setTick(t => t + 1), 30_000)
    return () => { unsub(); clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  const statuses = getAllSyncStatus()
  const hasErrors = statuses.some(s => s.error)
  const pinnedStatuses = statuses.filter(s => pinned.includes(s.key))
  const summaryAge = pinnedStatuses.reduce((oldest, s) => {
    if (s.ageMs === null) return oldest
    return oldest === null || s.ageMs > oldest ? s.ageMs : oldest
  }, null)
  const summaryLabel = hasErrors
    ? 'Sync error'
    : (summaryAge === null ? 'Not synced' : `Synced ${formatAge(summaryAge)}`)

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      await runAutoSync({ force: true })
      toast.success('Sync triggered. Data will refresh as each source returns.', { duration: 4000 })
    } catch (e) {
      toast.error(`Sync failed: ${e.message || e}`)
    } finally {
      setTimeout(() => setSyncing(false), 800)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        title={hasErrors ? 'One or more syncs failed — click for details' : 'Data sync status'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          minHeight: 36,
          background: 'var(--paper)',
          border: `1px solid ${hasErrors ? 'var(--down)' : 'var(--rule)'}`,
          color: hasErrors ? 'var(--down)' : 'var(--ink-3)',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          fontWeight: 500,
          borderRadius: 9,
          transition: 'border-color 160ms ease, color 160ms ease',
        }}
      >
        {hasErrors
          ? <AlertTriangle size={ICON.sm} style={{ color: 'var(--down)' }} />
          : <Clock size={ICON.sm} style={{ color: 'var(--ink-3)' }} />}
        <span className="hidden sm:inline">{summaryLabel}</span>
        <span className="sm:hidden">{hasErrors ? 'Error' : (summaryAge === null ? 'Never' : formatAge(summaryAge))}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 dropdown-panel min-w-[320px]">
          <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--rule)' }}>
            <span className="eyebrow eyebrow-accent" style={{ fontSize: 9 }}>Background syncs</span>
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 9px',
                background: 'var(--accent)',
                color: 'var(--ink)',
                fontFamily: 'var(--mono)',
                fontSize: 9.5,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                borderRadius: 9,
                opacity: syncing ? 0.5 : 1,
                cursor: syncing ? 'wait' : 'pointer',
              }}
            >
              <RefreshCw size={ICON.sm} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <div className="py-1">
            {statuses.map(s => (
              <div key={s.key} className="flex flex-col gap-0.5 px-4 py-2" style={{ fontSize: 12 }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {s.error ? (
                      <AlertTriangle size={ICON.sm} style={{ color: 'var(--down)' }} className="shrink-0" />
                    ) : s.ageMs === null || s.overdue ? (
                      <Clock size={ICON.sm} style={{ color: '#b88200' }} className="shrink-0" />
                    ) : (
                      <Check size={ICON.sm} style={{ color: 'var(--up)' }} className="shrink-0" />
                    )}
                    <span style={{ color: 'var(--ink-2)' }} className="truncate">{s.label}</span>
                  </div>
                  <span
                    className="tabular-nums whitespace-nowrap"
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      letterSpacing: '0.06em',
                      color: 'var(--ink-3)',
                    }}
                  >
                    {formatAge(s.ageMs)}
                  </span>
                </div>
                {s.error && (
                  <p
                    style={{
                      fontSize: 10,
                      color: 'var(--down)',
                      paddingLeft: 22,
                      lineHeight: 1.45,
                      wordBreak: 'break-word',
                      margin: 0,
                    }}
                  >
                    {s.error}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div
            className="px-4 py-2"
            style={{
              borderTop: '1px solid var(--rule)',
              fontSize: 10,
              color: 'var(--ink-3)',
              fontFamily: 'var(--sans)', fontStyle: 'italic',
              lineHeight: 1.45,
            }}
          >
            Runs automatically in the background — no manual click needed. Date-range changes always refresh display immediately.
          </div>
        </div>
      )}
    </div>
  )
}
