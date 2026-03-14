import { useState, useEffect } from 'react'
import { fetchPipelineAnalytics, extractFunnel, extractDialerMetrics, extractSpeedToLead, extractSourceOutcomes } from '../services/ghlApi'

export function usePipelineAnalytics(days = 30) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const analytics = await fetchPipelineAnalytics(days)
        if (!cancelled) {
          setData({
            raw: analytics,
            funnel: extractFunnel(analytics),
            dialer: extractDialerMetrics(analytics),
            speedToLead: extractSpeedToLead(analytics),
            sourceOutcomes: extractSourceOutcomes(analytics),
          })
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [days])

  return { data, loading, error }
}
