import { useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import AttributeHeatmap from '../../components/ads/AttributeHeatmap'
import { SectionHead } from '../../components/editorial/atoms'

/*
  Cross-attribute explorations — reads since/until window from the shared
  Outlet context. AttributeHeatmap still calls its own dedicated RPC
  (lib_perf_heatmap) because it's a different aggregation than perf rows.
*/

export default function AdsExplorations() {
  const { perf, since, until } = useOutletContext()

  const baseline = useMemo(() => {
    const rows = perf || []
    const tagged = rows.filter(r => r.hook_type != null)
    if (!tagged.length) return 0
    const winners = rows.filter(r => r.effective_winner).length
    return winners / tagged.length
  }, [perf])

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Explorations"
        title="Cross-attribute interactions."
        italicWord="interactions"
        tagline="Pick two attributes — the heatmap surfaces where combinations beat the baseline. Yellow cells beat baseline, intensity scales with win rate."
        gap={28}
      />
      <AttributeHeatmap since={since} until={until} baseline={baseline} />
    </div>
  )
}
