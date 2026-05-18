import { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AddOrLinkCreativeDrawer from '../../components/ads/AddOrLinkCreativeDrawer'
import CreativeEditDrawer from '../../components/ads/CreativeEditDrawer'
import CreativeGrid from '../../components/ads/CreativeGrid'
import { SectionHead, Button, Icon } from '../../components/editorial/atoms'
import { updateAdAttributes } from '../../services/creativeTagger'
import { useToast } from '../../hooks/useToast'

/*
  Creatives library — full ad spreadsheet.
  Reads perf data from the parent AdsCreativeTestingLayout's Outlet context
  so we share one fetch with Insights / Attributes / Explorations.
*/

export default function AdsCreativesLibrary() {
  // Library uses perfRaw so excluded ads are still visible — otherwise Ben
  // couldn't see what's excluded to un-exclude it. The "Excluded" chip in
  // CreativeGrid lets him narrow to just those when he wants.
  const { perfRaw, perf, loading, refresh, activeOffers, activeCampaigns, hideInactive } = useOutletContext()
  const toast = useToast()
  const [editingAd, setEditingAd] = useState(null)
  const [addDrawerOpen, setAddDrawerOpen] = useState(false)

  // Inline winner toggle — flips manual_winner_override directly on the
  // ad without opening the edit drawer. After-the-fact refresh re-pulls
  // perf so the row repaints with the new state.
  async function handleToggleWinner(ad, nextWinner) {
    try {
      await updateAdAttributes(ad.ad_id, { manual_winner_override: nextWinner })
      toast?.success?.(nextWinner ? `Marked "${ad.ad_name}" as winner` : `Unmarked "${ad.ad_name}"`)
      refresh && refresh()
    } catch (e) {
      toast?.error?.(`Winner toggle failed: ${e.message}`)
    }
  }

  // Exclude this ad from the testing analysis (win-rate, variables, charts).
  // Operator uses this for evergreen creatives that shouldn't pollute the
  // baseline. Excluded ads still appear in the Library when "Excluded" filter
  // chip is active.
  async function handleToggleExclude(ad, nextExcluded) {
    try {
      await updateAdAttributes(ad.ad_id, { exclude_from_tests: nextExcluded })
      toast?.success?.(nextExcluded
        ? `Excluded "${ad.ad_name}" from testing analytics`
        : `Re-included "${ad.ad_name}" in testing`)
      refresh && refresh()
    } catch (e) {
      toast?.error?.(`Exclude toggle failed: ${e.message}`)
    }
  }

  // Apply the same offer / campaign / hide-inactive filters the toolbar
  // owns, but pull from perfRaw so excluded ads are still in scope.
  const filteredPerf = useMemo(() => {
    let rows = perfRaw || perf || []
    if (activeOffers?.length) rows = rows.filter(r => activeOffers.includes(r.offer_slug))
    if (activeCampaigns?.length) rows = rows.filter(r => activeCampaigns.includes(r.campaign_name))
    if (hideInactive) {
      rows = rows.filter(r =>
        (Number(r.spend)  || 0) > 0 ||
        (Number(r.leads)  || 0) > 0 ||
        (Number(r.booked) || 0) > 0
      )
    }
    return rows
  }, [perfRaw, perf, activeOffers, activeCampaigns, hideInactive])

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
        onToggleWinner={handleToggleWinner}
        onToggleExclude={handleToggleExclude}
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
