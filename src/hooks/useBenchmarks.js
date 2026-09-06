import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/*
  Targets for every KPI tile and gauge, from marketing_benchmarks.

  One place, one number per metric, edited on the Settings page. Ben set
  these on 6 Sep 2026: cpl 150, cpb 300, cost_per_live_call 600,
  show_rate_new 50, close_rate 30, cpa_trial 2000, trial_fe_roas 1.5.

  Returns { cpl: 150, ... } with numeric values, plus a `bm(key, fallback)`
  helper. Cached at module level so Overview, Closers and Setters share
  one fetch per session.
*/

let cache = null
let inflight = null

async function load() {
  if (cache) return cache
  if (!inflight) {
    inflight = supabase.from('marketing_benchmarks').select('metric, value').then(({ data, error }) => {
      if (error) { inflight = null; throw error }
      cache = Object.fromEntries((data || []).map(r => [r.metric, parseFloat(r.value)]))
      return cache
    })
  }
  return inflight
}

export function invalidateBenchmarks() { cache = null; inflight = null }

export function useBenchmarks() {
  const [benchmarks, setBenchmarks] = useState(cache || {})
  useEffect(() => {
    let alive = true
    load().then(b => { if (alive) setBenchmarks(b) }).catch(err => console.warn('benchmarks failed:', err))
    return () => { alive = false }
  }, [])
  const bm = (key, fallback = null) => {
    const v = benchmarks?.[key]
    return Number.isFinite(v) ? v : fallback
  }
  return { benchmarks, bm }
}
