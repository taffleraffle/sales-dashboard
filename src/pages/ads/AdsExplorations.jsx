import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabase'
import AttributeHeatmap from '../../components/ads/AttributeHeatmap'
import { SectionHead } from '../../components/editorial/atoms'

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (d) => {
  const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10)
}

export default function AdsExplorations() {
  const [perf, setPerf] = useState([])
  const [loading, setLoading] = useState(true)
  const [since] = useState(daysAgoISO(90))
  const [until] = useState(todayISO())
  const [activeOffers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await supabase.rpc('lib_ad_performance', { since, until })
      setPerf(res.data || [])
    } finally { setLoading(false) }
  }, [since, until])
  useEffect(() => { load() }, [load])

  const baseline = useMemo(() => {
    const tagged = perf.filter(r => r.hook_type != null)
    if (!tagged.length) return 0
    const winners = perf.filter(r => r.effective_winner).length
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
