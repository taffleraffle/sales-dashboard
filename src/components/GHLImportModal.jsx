import { useState, useEffect } from 'react'
import { X, Loader, Download, Check } from 'lucide-react'
import { fetchPipelines, fetchOpportunities } from '../services/ghlPipeline'
import { supabase } from '../lib/supabase'

export default function GHLImportModal({ clients, onClose, onImported }) {
  const [step, setStep] = useState(1) // 1=select pipeline, 2=loading, 3=preview, 4=importing
  const [pipelines, setPipelines] = useState([])
  const [loadingPipelines, setLoadingPipelines] = useState(true)
  const [selectedPipeline, setSelectedPipeline] = useState(null)
  const [contacts, setContacts] = useState([])
  const [progress, setProgress] = useState({ loaded: 0, total: 0 })
  const [selected, setSelected] = useState(new Set())
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  // Fetch pipelines on mount
  useEffect(() => {
    fetchPipelines()
      .then(p => { setPipelines(p); setLoadingPipelines(false) })
      .catch(() => setLoadingPipelines(false))
  }, [])

  // Build a set of existing emails for duplicate detection
  const existingEmails = new Set(clients.filter(c => c.email).map(c => c.email.toLowerCase()))

  const handleSelectPipeline = async (pipeline) => {
    setSelectedPipeline(pipeline)
    setStep(2)
    try {
      const opps = await fetchOpportunities(pipeline.id, (loaded, total) => {
        setProgress({ loaded, total })
      })

      // Extract contacts from opportunities
      const mapped = opps.map(o => {
        const contact = o.contact || {}
        const name = contact.name || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || o.name || ''
        const email = contact.email || ''
        const isDuplicate = email && existingEmails.has(email.toLowerCase())
        return {
          id: o.id,
          name,
          email,
          phone: contact.phone || '',
          company: contact.companyName || o.companyName || '',
          stage: o.pipelineStageId,
          stageName: pipeline.stages.find(s => s.id === o.pipelineStageId)?.name || 'Unknown',
          isDuplicate,
          monetaryValue: o.monetaryValue || 0,
        }
      }).filter(c => c.name) // Skip blank names

      setContacts(mapped)
      // Pre-select non-duplicates
      const initialSelected = new Set(mapped.filter(c => !c.isDuplicate).map(c => c.id))
      setSelected(initialSelected)
      setStep(3)
    } catch (err) {
      console.error('GHL fetch error:', err)
      setStep(1)
    }
  }

  const toggleSelect = (id) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const toggleAll = () => {
    if (selected.size === contacts.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(contacts.map(c => c.id)))
    }
  }

  const handleImport = async () => {
    setImporting(true)
    const toImport = contacts.filter(c => selected.has(c.id))

    const insertRows = toImport.map(c => ({
      name: c.name,
      email: c.email || null,
      phone: c.phone || null,
      company_name: c.company || null,
      stage: 'trial',
      trial_start_date: new Date().toISOString().split('T')[0],
      monthly_amount: c.monetaryValue || 0,
      ghl_contact_id: c.id,
    }))

    const { data, error } = await supabase.from('clients').insert(insertRows).select('id')
    if (error) {
      setResult({ error: error.message })
    } else {
      setResult({ count: data.length })
    }
    setImporting(false)
    setStep(4)
    if (!error) onImported()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="tile tile-feedback shadow-2xl w-full max-w-2xl mx-4 max-h-[80vh] flex flex-col slide-in-right" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
          <div>
            <h2 className="text-sm font-bold text-text-primary">Import from GHL</h2>
            <p className="text-[10px] text-text-400">Pull closed deals from GoHighLevel pipelines</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Step 1: Select Pipeline */}
          {step === 1 && (
            <div>
              <h3 className="text-xs font-medium text-text-secondary mb-3">Select a pipeline</h3>
              {loadingPipelines ? (
                <div className="flex items-center justify-center py-8 text-text-400 text-xs">
                  <Loader size={14} className="animate-spin mr-2" /> Loading pipelines...
                </div>
              ) : pipelines.length === 0 ? (
                <p className="text-text-400 text-xs text-center py-8">No pipelines found. Check your GHL API key.</p>
              ) : (
                <div className="space-y-2">
                  {pipelines.map(p => (
                    <button
                      key={p.id}
                      onClick={() => handleSelectPipeline(p)}
                      className="w-full text-left bg-bg-primary border border-border-default rounded-xl p-3 hover:border-opt-yellow/30 hover:bg-opt-yellow/5 transition-all duration-150"
                    >
                      <span className="text-xs font-medium text-text-primary">{p.name}</span>
                      <span className="text-[10px] text-text-400 ml-2">({p.stages.length} stages)</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Loading */}
          {step === 2 && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader size={24} className="animate-spin text-opt-yellow mb-3" />
              <p className="text-xs text-text-primary mb-1">Fetching opportunities...</p>
              <p className="text-[10px] text-text-400">{progress.loaded} of {progress.total || '?'} loaded</p>
            </div>
          )}

          {/* Step 3: Preview */}
          {step === 3 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-medium text-text-secondary">
                  {selectedPipeline?.name} — {contacts.length} contacts
                </h3>
                <div className="flex items-center gap-2 text-[10px] text-text-400">
                  <span className="text-warning">{contacts.filter(c => c.isDuplicate).length} duplicates</span>
                  <span>{selected.size} selected</span>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[400px] overflow-y-auto border border-border-default rounded-xl">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-bg-card z-10">
                    <tr className="text-text-400 uppercase text-[10px] tracking-wider">
                      <th className="px-2 py-2 text-left w-8">
                        <input type="checkbox" checked={selected.size === contacts.length} onChange={toggleAll} className="accent-opt-yellow" />
                      </th>
                      <th className="px-2 py-2 text-left">Name</th>
                      <th className="px-2 py-2 text-left">Email</th>
                      <th className="px-2 py-2 text-left">Company</th>
                      <th className="px-2 py-2 text-left">Stage</th>
                      <th className="px-2 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map(c => (
                      <tr key={c.id} className={`border-t border-border-default/30 ${c.isDuplicate ? 'bg-warning/5' : ''}`}>
                        <td className="px-2 py-1.5">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} className="accent-opt-yellow" />
                        </td>
                        <td className="px-2 py-1.5 text-text-primary">{c.name}</td>
                        <td className="px-2 py-1.5 text-text-400 text-[10px]">{c.email || '—'}</td>
                        <td className="px-2 py-1.5 text-text-400">{c.company || '—'}</td>
                        <td className="px-2 py-1.5 text-text-400 text-[10px]">{c.stageName}</td>
                        <td className="px-2 py-1.5">
                          {c.isDuplicate ? (
                            <span className="text-[10px] text-warning font-medium">Duplicate</span>
                          ) : (
                            <span className="text-[10px] text-success font-medium">New</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Step 4: Result */}
          {step === 4 && (
            <div className="flex flex-col items-center justify-center py-12">
              {result?.error ? (
                <>
                  <X size={24} className="text-danger mb-3" />
                  <p className="text-xs text-danger">Error: {result.error}</p>
                </>
              ) : (
                <>
                  <Check size={24} className="text-success mb-3" />
                  <p className="text-xs text-text-primary">Imported {result?.count || 0} clients</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {step === 3 && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border-default">
            <button onClick={() => setStep(1)} className="px-4 py-2 text-xs font-medium border border-border-default text-text-secondary rounded-xl hover:bg-bg-card-hover transition-all duration-150">
              Back
            </button>
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="px-5 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 disabled:opacity-50 transition-all duration-150 flex items-center gap-1.5"
            >
              {importing ? <><Loader size={12} className="animate-spin" /> Importing...</> : <><Download size={12} /> Import {selected.size} Clients</>}
            </button>
          </div>
        )}
        {step === 4 && (
          <div className="flex items-center justify-end px-5 py-3 border-t border-border-default">
            <button onClick={onClose} className="px-5 py-2 text-xs font-medium bg-opt-yellow text-bg-primary rounded-xl hover:brightness-110 transition-all duration-150">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
