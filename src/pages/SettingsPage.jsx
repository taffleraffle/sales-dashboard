import { useState } from 'react'
import { Check, X, RefreshCw } from 'lucide-react'
import { syncFathomTranscripts } from '../services/fathomSync'
import { syncMetaAds } from '../services/metaAdsSync'
import { syncHyrosAttribution } from '../services/hyrosSync'

const apiConfigs = [
  { key: 'meta', label: 'Meta Ads API', envVar: 'VITE_META_ADS_ACCESS_TOKEN', description: 'Pulls ad spend, CPL, CPC, impressions, leads' },
  { key: 'hyros', label: 'Hyros API', envVar: 'VITE_HYROS_API_KEY', description: 'Pulls revenue attribution, ROAS per campaign' },
  { key: 'fathom', label: 'Fathom API', envVar: 'VITE_FATHOM_API_KEY', description: 'Pulls call transcripts for objection analysis' },
]

export default function SettingsPage() {
  const [syncing, setSyncing] = useState(null)
  const [lastResult, setLastResult] = useState(null)

  const getStatus = (envVar) => {
    const val = import.meta.env[envVar]
    return val && val.length > 0
  }

  const handleSync = async (key) => {
    setSyncing(key)
    setLastResult(null)
    try {
      if (key === 'fathom') {
        const result = await syncFathomTranscripts()
        setLastResult({ key, success: true, message: `Synced ${result.synced} transcripts (${result.skipped} skipped)` })
      } else if (key === 'meta') {
        const result = await syncMetaAds()
        setLastResult({ key, success: true, message: `Synced ${result.synced} ad records (${result.skipped} skipped)` })
      } else if (key === 'hyros') {
        const result = await syncHyrosAttribution()
        setLastResult({ key, success: true, message: `Synced ${result.synced} attribution records (${result.skipped} skipped)` })
      }
    } catch (err) {
      setLastResult({ key, success: false, message: err.message })
    }
    setSyncing(null)
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Settings</h1>

      <div className="space-y-4">
        <h2 className="text-sm font-medium text-text-secondary">API Connections</h2>

        {apiConfigs.map(api => {
          const connected = getStatus(api.envVar)
          const result = lastResult?.key === api.key ? lastResult : null
          return (
            <div key={api.key} className="bg-bg-card border border-border-default rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    {connected ? (
                      <Check size={14} className="text-success" />
                    ) : (
                      <X size={14} className="text-danger" />
                    )}
                    <span className="font-medium text-sm">{api.label}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded ${connected ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                      {connected ? 'Connected' : 'Not configured'}
                    </span>
                  </div>
                  <p className="text-xs text-text-400">{api.description}</p>
                </div>
                {connected && (
                  <button
                    onClick={() => handleSync(api.key)}
                    disabled={syncing === api.key}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-bg-primary border border-border-default text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    <RefreshCw size={12} className={syncing === api.key ? 'animate-spin' : ''} />
                    {syncing === api.key ? 'Syncing...' : 'Sync Now'}
                  </button>
                )}
              </div>
              {result && (
                <p className={`text-xs mt-2 ${result.success ? 'text-success' : 'text-danger'}`}>
                  {result.message}
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-text-secondary mb-3">Supabase</h2>
        <div className="bg-bg-card border border-border-default rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <Check size={14} className="text-success" />
            <span className="font-medium text-sm">Supabase</span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-success/15 text-success">Connected</span>
          </div>
          <p className="text-xs text-text-400">{import.meta.env.VITE_SUPABASE_URL}</p>
        </div>
      </div>

      <div className="mt-8">
        <h2 className="text-sm font-medium text-text-secondary mb-3">Team Members</h2>
        <p className="text-xs text-text-400 mb-2">
          To add closer/setter emails for Fathom matching, update the <code className="text-text-secondary">email</code> column
          in the <code className="text-text-secondary">team_members</code> table in Supabase.
        </p>
      </div>
    </div>
  )
}
