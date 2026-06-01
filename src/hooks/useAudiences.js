import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'

/*
  Single source of truth for audience definitions across the app.

  Reads public.audience_definitions (migration 131). Replaces the four
  hardcoded constants the old code shipped with:
    - MarketingPerformance.CANONICAL_AUDIENCES
    - AttributionCoverage.KANBAN_COLUMNS / KNOWN_AUDIENCES / UTM_CAMPAIGN_MAP

  Adding a new audience in the Settings → Manage Audiences UI updates this
  table, the SQL parser (audience_from_campaign_name) reads keywords from
  it, every view (lib_ad_audience / lib_marketing_by_audience_daily /
  lib_strategy_booking_resolved) JOINs it, and this hook re-pulls on any
  mutation — so every page picks up the new audience without a deploy.

  Shape: each row is
    { slug, display_name, keywords, color, sort_order, calendar_ids,
      example_utm, is_active, is_dq, notes, created_at, updated_at }

  Returns:
    audiences  — array, sorted by sort_order asc, only is_active=true
    bySlug     — { slug: row }
    byDisplay  — { display_name: row }
    refresh    — () => re-pull
    busy       — true on first load
    error      — string | null
*/

export function useAudiences({ includeInactive = false } = {}) {
  const [audiences, setAudiences] = useState([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(() => setReloadKey(k => k + 1), [])

  useEffect(() => {
    let alive = true
    setBusy(true)
    let q = supabase.from('audience_definitions').select('*').order('sort_order', { ascending: true })
    if (!includeInactive) q = q.eq('is_active', true)
    q.then(({ data, error }) => {
      if (!alive) return
      if (error) { setError(error.message); setAudiences([]); return }
      setAudiences(data || [])
      setError(null)
    }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [reloadKey, includeInactive])

  const bySlug = Object.fromEntries(audiences.map(a => [a.slug, a]))
  const byDisplay = Object.fromEntries(audiences.map(a => [a.display_name, a]))

  return { audiences, bySlug, byDisplay, refresh, busy, error }
}

// Parser mirror — applies the same keyword logic the SQL parser uses,
// for client-side previews ("which campaigns would this match?"). Lower
// sort_order wins, matching the SQL ORDER BY.
export function parseAudienceFromString(text, audiences) {
  if (!text) return null
  const s = text.toLowerCase()
  const sorted = [...(audiences || [])].sort((a, b) => (a.sort_order ?? 100) - (b.sort_order ?? 100))
  for (const a of sorted) {
    if (!a.is_active) continue
    for (const kw of (a.keywords || [])) {
      if (s.includes(String(kw).toLowerCase())) return a
    }
  }
  return null
}
