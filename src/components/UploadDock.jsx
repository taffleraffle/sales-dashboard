import { useUploads } from '../hooks/useUploads'
import { X, Loader, Check, AlertCircle } from 'lucide-react'

/*
  Floating top-right card showing live upload progress. Mounted once by
  Layout so it persists across all page navigations.
*/

export default function UploadDock() {
  const { runs, dismiss } = useUploads()
  if (!runs.length) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 76,
        right: 16,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 280,
        maxWidth: '90vw',
        pointerEvents: 'none',
      }}
    >
      {runs.map(r => <RunCard key={r.id} run={r} onDismiss={() => dismiss(r.id)} />)}
    </div>
  )
}

function RunCard({ run, onDismiss }) {
  const pct = run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0
  const isDone = run.status === 'done'
  const hasFailures = run.failed.length > 0
  const accent = hasFailures && isDone ? 'var(--down)' : 'var(--accent)'
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderLeftWidth: 3,
        borderLeftColor: accent,
        borderRadius: 3,
        boxShadow: '0 4px 16px rgba(10,10,10,0.10)',
        padding: 12,
        pointerEvents: 'auto',
        animation: 'slide-in-right 200ms ease-out',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {isDone
          ? (hasFailures
            ? <AlertCircle size={14} style={{ color: 'var(--down)', flexShrink: 0 }} />
            : <Check size={14} style={{ color: 'var(--up, #2a8e3a)', flexShrink: 0 }} />)
          : <Loader size={14} className="animate-spin" style={{ color: 'var(--ink-3)', flexShrink: 0 }} />}
        <div
          style={{
            flex: 1, minWidth: 0,
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600,
            color: 'var(--ink)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}
          title={run.label}
        >
          {run.label}
        </div>
        <button
          onClick={onDismiss}
          aria-label="dismiss"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-4)', padding: 2 }}
        >
          <X size={12} />
        </button>
      </div>

      {/* Body */}
      <div style={{ fontFamily: 'var(--serif)', fontSize: 13, color: 'var(--ink-2)', marginBottom: 8 }}>
        {isDone ? (
          hasFailures
            ? `${run.done - run.failed.length}/${run.total} uploaded · ${run.failed.length} failed`
            : `${run.done}/${run.total} uploaded`
        ) : (
          `Uploaded ${run.done} / ${run.total}…`
        )}
      </div>

      {/* Progress bar */}
      <div style={{ height: 4, background: 'var(--paper-2)', borderRadius: 2, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: accent,
            transition: 'width 250ms ease',
          }}
        />
      </div>

      {/* Failed list (if any) */}
      {hasFailures && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--down)', marginBottom: 4 }}>
            Failed
          </div>
          {run.failed.slice(0, 3).map((f, i) => (
            <div key={i} title={f.error} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.file}
            </div>
          ))}
          {run.failed.length > 3 && (
            <div style={{ fontSize: 10, color: 'var(--ink-4)' }}>+{run.failed.length - 3} more</div>
          )}
        </div>
      )}
    </div>
  )
}
