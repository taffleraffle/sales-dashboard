import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AttributesView from '../../components/ads/AttributesView'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import { SectionHead } from '../../components/editorial/atoms'

/*
  Attributes drill-down — shares perf data with sibling pages via the
  AdsCreativeTestingLayout Outlet context. No own RPC fetch.
*/

export default function AdsAttributesPage() {
  const { perf, loading, refresh } = useOutletContext()
  const [editingAd, setEditingAd] = useState(null)

  const activeOffers = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
  }, [])

  const filteredPerf = useMemo(() => {
    const rows = perf || []
    if (!activeOffers.length) return rows
    return rows.filter(r => activeOffers.includes(r.offer_slug))
  }, [perf, activeOffers])

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
        onUpdated={refresh}
      />
    </div>
  )
}
