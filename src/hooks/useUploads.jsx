import { createContext, useCallback, useContext, useRef, useState } from 'react'

/*
  Global upload manager. Lives at Layout level so progress survives any
  page navigation. Pages call:

    const uploads = useUploads()
    const runId = uploads.start({ label: 'clips upload', total: files.length })
    for each file:
      try { ...await... ; uploads.progress(runId, { added: 1 }) }
      catch (e) { uploads.fail(runId, { file: f.name, error: e.message }) }
    uploads.done(runId)

  The floating UploadDock component renders the live state — it's mounted
  by Layout next to ToastProvider's toast list.
*/

const UploadContext = createContext(null)

let runCounter = 0

export function UploadProvider({ children }) {
  const [runs, setRuns] = useState([])     // [{id, label, total, done, failed: [{file, error}], status}]
  const removeTimers = useRef({})

  const start = useCallback(({ label, total }) => {
    const id = ++runCounter
    setRuns(prev => [...prev, { id, label: label || 'Upload', total, done: 0, failed: [], status: 'running' }])
    return id
  }, [])

  const progress = useCallback((id, { added = 1 } = {}) => {
    setRuns(prev => prev.map(r => r.id === id ? { ...r, done: r.done + added } : r))
  }, [])

  const fail = useCallback((id, { file, error }) => {
    setRuns(prev => prev.map(r => r.id === id ? { ...r, failed: [...r.failed, { file, error }] } : r))
  }, [])

  const done = useCallback((id) => {
    setRuns(prev => prev.map(r => r.id === id ? { ...r, status: 'done' } : r))
    // Auto-remove successful runs after 8s so the dock self-clears.
    // Keep failures so the operator can still see what broke.
    removeTimers.current[id] = setTimeout(() => {
      setRuns(prev => {
        const run = prev.find(r => r.id === id)
        if (run && run.failed.length === 0) return prev.filter(r => r.id !== id)
        return prev
      })
    }, 8000)
  }, [])

  const dismiss = useCallback((id) => {
    if (removeTimers.current[id]) clearTimeout(removeTimers.current[id])
    setRuns(prev => prev.filter(r => r.id !== id))
  }, [])

  const api = { start, progress, fail, done, dismiss, runs }
  return <UploadContext.Provider value={api}>{children}</UploadContext.Provider>
}

export function useUploads() {
  const ctx = useContext(UploadContext)
  if (!ctx) {
    return {
      start: () => null,
      progress: () => {},
      fail: () => {},
      done: () => {},
      dismiss: () => {},
      runs: [],
    }
  }
  return ctx
}
