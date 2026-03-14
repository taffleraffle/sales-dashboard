import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function useEODSubmit() {
  const [submitting, setSubmitting] = useState(false)

  const submitCloserEOD = async (closerId, reportDate, data, calls = []) => {
    setSubmitting(true)
    try {
      // Upsert the EOD report
      const { data: report, error: reportError } = await supabase
        .from('closer_eod_reports')
        .upsert({
          closer_id: closerId,
          report_date: reportDate,
          ...data,
          is_confirmed: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'closer_id,report_date' })
        .select()
        .single()

      if (reportError) throw reportError

      // Insert calls if any
      if (calls.length > 0) {
        // Delete existing calls for this report
        await supabase.from('closer_calls').delete().eq('eod_report_id', report.id)

        const callRows = calls.map(c => ({
          eod_report_id: report.id,
          call_type: c.call_type,
          prospect_name: c.prospect_name,
          showed: c.showed,
          outcome: c.outcome,
          revenue: c.revenue || 0,
          cash_collected: c.cash_collected || 0,
          notes: c.notes || '',
        }))
        const { error: callError } = await supabase.from('closer_calls').insert(callRows)
        if (callError) throw callError
      }

      return { success: true, report }
    } catch (err) {
      console.error('Closer EOD submit failed:', err)
      return { success: false, error: err.message }
    } finally {
      setSubmitting(false)
    }
  }

  const submitSetterEOD = async (setterId, reportDate, data) => {
    setSubmitting(true)
    try {
      const { data: report, error } = await supabase
        .from('setter_eod_reports')
        .upsert({
          setter_id: setterId,
          report_date: reportDate,
          ...data,
          is_confirmed: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'setter_id,report_date' })
        .select()
        .single()

      if (error) throw error
      return { success: true, report }
    } catch (err) {
      console.error('Setter EOD submit failed:', err)
      return { success: false, error: err.message }
    } finally {
      setSubmitting(false)
    }
  }

  return { submitCloserEOD, submitSetterEOD, submitting }
}
