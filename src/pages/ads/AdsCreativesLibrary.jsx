import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import CreativeGrid from '../../components/ads/CreativeGrid'
import { SectionHead, Button, Icon } from '../../components/editorial/atoms'

/*
  Creatives library — full ad spreadsheet.
  Reads perf data from the parent AdsCreativeTestingLayout's Outlet context
  so we share one fetch with Insights / Attributes / Explorations.
*/

export default function AdsCreativesLibrary() {
  const { perf, loading, refresh } = useOutletContext()
  const [editingAd, setEditingAd] = useState(null)
  const [addDrawerOpen, setAddDrawerOpen] = useState(false)

  // Respect offer filter from localStorage (set by Insights' filter bar)
  const activeOffers = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
  }, [])

  const filteredPerf = useMemo(() => {
    const rows = perf || []
    if (!activeOffers.length) return rows
    return rows.filter(r => activeOffers.includes(r.offer_slug))
  }, [perf, activeOffers])

  return (
    <div>
      <SectionHead
        level="page"
        eyebrow="Creative · Library"
        title="Every creative."
        italicWord="Every"
        tagline={`${(perf || []).length} ads in scope. Filter by attribute, sort by booked / CPB / spend. Click any row to edit.`}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="primary" leftIcon={Icon.plus(13)} onClick={() => setAddDrawerOpen(true)}>
              Add or link creative
            </Button>
          </div>
        }
        gap={28}
      />

      <CreativeGrid
        rows={filteredPerf}
        loading={loading}
        onClickRow={r => setEditingAd(r)}
        pinnedTopN={3}
      />

      <AddOrLinkCreativeDrawer
        open={addDrawerOpen}
        onClose={() => setAddDrawerOpen(false)}
        onLinked={() => { setAddDrawerOpen(false); refresh() }}
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
