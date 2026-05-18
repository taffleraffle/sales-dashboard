import { useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import AttributesView from '../../components/ads/AttributesView'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import { SectionHead, Button, Icon } from '../../components/editorial/atoms'

/*
  Attributes drill-down — left rail of all 11 attributes, right pane with
  hero + value breakdown + combination matrix + top creatives. Mirrors
  the design-package Attributes.html.
*/

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (d) => {
  const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10)
}

export default function AdsAttributesPage() {
  const [perf, setPerf] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingAd, setEditingAd] = useState(null)
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

  const filteredPerf = useMemo(() => {
    if (!activeOffers.length) return perf
    return perf.filter(r => activeOffers.includes(r.offer_slug))
  }, [perf, activeOffers])

  // Baseline win rate = winners / tagged_ads across the visible set
  const baseline = useMemo(() => {
    const tagged = filteredPerf.filter(r => r.hook_type != null)
    if (!tagged.length) return 0
    const winners = filteredPerf.filter(r => r.effective_winner).length
    return (winners / tagged.length) * 100
  }, [filteredPerf])

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Attributes"
        title="Pull any dimension apart."
        italicWord="any"
        tagline="Eleven attributes. For each, the values with statistical sample, ranked by what they're producing. Pick an attribute on the left."
        gap={28}
      />

      <AttributesView
        filteredPerf={filteredPerf}
        baseline={baseline}
        loading={loading}
        onClickCreative={r => setEditingAd(r)}
      />

      <CreativeEditDrawer
        ad={editingAd}
        open={!!editingAd}
        onClose={() => setEditingAd(null)}
        onUpdated={() => load()}
      />
    </div>
  )
}
