import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { sinceDate } from '../lib/dateUtils'

export function useFunnelData(days = 30) {
  const [data, setData] = useState({ leads: 0, bookings: 0, shows: 0, closes: 0, autoBookings: 0, manualSets: 0, autoShows: 0, autoCloses: 0, manualShows: 0, manualCloses: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: leads } = await supabase
        .from('setter_leads')
        .select('id, status, lead_source, revenue_attributed')
        .gte('date_set', sinceDate(days))

      const all = leads || []
      const auto = all.filter(l => l.lead_source === 'auto')
      const manual = all.filter(l => l.lead_source !== 'auto')

      const showStatuses = ['showed', 'closed', 'not_closed']

      setData({
        leads: all.length,
        bookings: all.filter(l => l.status !== 'cancelled').length,
        shows: all.filter(l => showStatuses.includes(l.status)).length,
        closes: all.filter(l => l.status === 'closed').length,
        revenue: all.reduce((s, l) => s + parseFloat(l.revenue_attributed || 0), 0),
        autoBookings: auto.length,
        manualSets: manual.length,
        autoShows: auto.filter(l => showStatuses.includes(l.status)).length,
        autoCloses: auto.filter(l => l.status === 'closed').length,
        manualShows: manual.filter(l => showStatuses.includes(l.status)).length,
        manualCloses: manual.filter(l => l.status === 'closed').length,
        autoShowRate: auto.filter(l => ['showed','closed','not_closed','no_show'].includes(l.status)).length ?
          parseFloat((auto.filter(l => showStatuses.includes(l.status)).length / auto.filter(l => ['showed','closed','not_closed','no_show'].includes(l.status)).length * 100).toFixed(1)) : 0,
        manualShowRate: manual.filter(l => ['showed','closed','not_closed','no_show'].includes(l.status)).length ?
          parseFloat((manual.filter(l => showStatuses.includes(l.status)).length / manual.filter(l => ['showed','closed','not_closed','no_show'].includes(l.status)).length * 100).toFixed(1)) : 0,
        autoCloseRate: auto.filter(l => showStatuses.includes(l.status)).length ?
          parseFloat((auto.filter(l => l.status === 'closed').length / auto.filter(l => showStatuses.includes(l.status)).length * 100).toFixed(1)) : 0,
        manualCloseRate: manual.filter(l => showStatuses.includes(l.status)).length ?
          parseFloat((manual.filter(l => l.status === 'closed').length / manual.filter(l => showStatuses.includes(l.status)).length * 100).toFixed(1)) : 0,
      })
      setLoading(false)
    }
    load()
  }, [days])

  return { data, loading }
}
