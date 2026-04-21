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

/**
 * Shows "Last synced: Xm ago" with a click-to-open dropdown listing every sync.
 * "Sync now" button force-runs all stale syncs.
 */
export default function SyncStatusIndicator({ pinned = ['meta', 'marketingTracker'] }) {
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const ref = useRef(null)
  const toast = useToast()

  // Re-render when a sync completes or every 30s so age keeps updating
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
  // Summary age = oldest age among pinned keys (so user sees the "worst case")
  const pinnedStatuses = statuses.filter(s => pinned.includes(s.key))
  const summaryAge = pinnedStatuses.reduce((oldest, s) => {
    if (s.ageMs === null) return oldest
    return oldest === null || s.ageMs > oldest ? s.ageMs : oldest
  }, null)
  const summaryLabel = hasErrors
    ? 'Sync error — click for details'
    : (summaryAge === null ? 'Not synced yet' : `Synced ${formatAge(summaryAge)}`)

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
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-bg-card border text-xs transition-colors min-h-[40px] ${
          hasErrors
            ? 'border-danger/40 text-danger hover:border-danger/60'
            : 'border-border-default text-text-secondary hover:border-opt-yellow/20'
        }`}
        title={hasErrors ? 'One or more syncs failed — click for details' : 'Data sync status'}
      >
        {hasErrors ? (
          <AlertTriangle size={ICON.sm} className="text-danger" />
        ) : (
          <Clock size={ICON.sm} className="text-text-400" />
        )}
        <span className="hidden sm:inline">{summaryLabel}</span>
        <span className="sm:hidden">{hasErrors ? 'error' : (summaryAge === null ? 'never' : formatAge(summaryAge))}</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-2 dropdown-panel min-w-[300px]">
          <div className="px-4 py-3 border-b border-border-default flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Background syncs</p>
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-opt-yellow/10 border border-opt-yellow/30 text-[11px] font-medium text-opt-yellow hover:bg-opt-yellow/20 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={ICON.sm} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <div className="py-1">
            {statuses.map(s => (
              <div key={s.key} className="flex flex-col gap-0.5 px-4 py-2 text-[12px]">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    {s.error ? (
                      <AlertTriangle size={ICON.sm} className="text-danger shrink-0" />
                    ) : s.ageMs === null || s.overdue ? (
                      <Clock size={ICON.sm} className="text-warning shrink-0" />
                    ) : (
                      <Check size={ICON.sm} className="text-success shrink-0" />
                    )}
                    <span className="text-text-secondary truncate">{s.label}</span>
                  </div>
                  <span className="text-text-400 tabular-nums text-[11px] whitespace-nowrap">
                    {formatAge(s.ageMs)}
                  </span>
                </div>
                {s.error && (
                  <p className="text-[10px] text-danger/90 pl-5 leading-snug break-words">
                    {s.error}
                  </p>
                )}
              </div>
            ))}
          </div>
          <div className="px-4 py-2 border-t border-border-default text-[10px] text-text-400 leading-snug">
            Runs automatically in the background — no manual click needed. Date-range changes always refresh display immediately.
          </div>
        </div>
      )}
    </div>
  )
}
