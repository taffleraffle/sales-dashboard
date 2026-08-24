import { useEffect, useState } from 'react'
import { getNzdToUsd, NZD_TO_USD_FALLBACK } from '../lib/fxRate'

/*
  Single source of truth for the NZD->USD display rate.

  Replaces the ten separate copies of

      const NZD_TO_USD = parseFloat(import.meta.env.VITE_NZD_TO_USD || '0.56')

  that were scattered across MarketingPerformance, AttributionCoverage,
  MetricTrendPanel, ComponentTable, ComponentDetail, AdDetail, AdsList,
  VariantDetail and metaAdsSync. Each one pinned the rate at whatever 0.56
  happened to be when it was written, so two pages could disagree about the
  same day's spend and nobody could tell which was right.

  THE CURRENCY CONTRACT (see also CLAUDE.md):
    - ad_daily_stats.spend / cpc / cpm are stored in NZD, always. Meta bills
      the OPT account in NZD and we keep the raw figure.
    - Conversion to USD happens once, at display time, through this hook.
    - No sync path may convert on write. metaAdsSync.js used to, which meant
      rows it wrote were converted twice by the time they reached a screen
      and read ~31% of true spend.

  Returns { rate, ts, live, loading }:
    rate     — NZD->USD multiplier. Starts on the static fallback so the
               first paint isn't blank, then upgrades when the live rate lands.
    ts       — epoch ms the live rate was fetched, or null on the fallback.
    live     — true once a real rate (or a fresh cache of one) is in hand.
    loading  — true until the first resolution settles.

  The underlying fetch is cached in localStorage for 12h by lib/fxRate.js,
  so mounting this on ten components costs one network call per half-day.
*/

export function useNzdToUsd() {
  const [fx, setFx] = useState({ rate: NZD_TO_USD_FALLBACK, ts: null, live: false, loading: true })

  useEffect(() => {
    let alive = true
    getNzdToUsd()
      .then(r => { if (alive) setFx({ ...r, loading: false }) })
      .catch(() => { if (alive) setFx(f => ({ ...f, loading: false })) })
    return () => { alive = false }
  }, [])

  return fx
}

export default useNzdToUsd
