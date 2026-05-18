import { useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from '../../lib/supabase'
import { listOffers } from '../../services/creativeTagger'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import CreativeGrid from '../../components/ads/CreativeGrid'
import { SectionHead, Button, Icon } from '../../components/editorial/atoms'

/*
  Creatives library — the all-ads spreadsheet, lifted out of the
  Insights in-page tabs and made a first-class route.

  Data: lib_ad_performance (since, until) joined to creative_attributes.
  Filters: date window + offer filter mirror the Insights page.
*/

const todayISO = () => new Date().toISOString().slice(0, 10)
const daysAgoISO = (d) => {
  const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10)
}

export default function AdsCreativesLibrary() {
  const [perf, setPerf] = useState([])
  const [offers, setOffers] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingAd, setEditingAd] = useState(null)
  const [addDrawerOpen, setAddDrawerOpen] = useState(false)
  const [since] = useState(daysAgoISO(90))   // wider default than Insights — Library should show more
  const [until] = useState(todayISO())
  const [activeOffers, setActiveOffers] = useState(() => {
    try { return JSON.parse(localStorage.getItem('insights.activeOffers') || '[]') } catch { return [] }
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [offersData, perfRes] = await Promise.all([
        listOffers(),
        supabase.rpc('lib_ad_performance', { since, until }),
      ])
      setOffers(offersData)
      setPerf(perfRes.data || [])
    } finally { setLoading(false) }
  }, [since, until])

  useEffect(() => { load() }, [load])

  const filteredPerf = useMemo(() => {
    if (!activeOffers.length) return perf
    return perf.filter(r => activeOffers.includes(r.offer_slug))
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
        onLinked={() => { setAddDrawerOpen(false); load() }}
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
