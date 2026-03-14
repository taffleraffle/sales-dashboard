import { useState } from 'react'
import { Check, X, RefreshCw } from 'lucide-react'

const apiConfigs = [
  { key: 'meta', label: 'Meta Ads API', envVar: 'VITE_META_ADS_ACCESS_TOKEN', description: 'Pulls ad spend, CPL, CPC, impressions, leads' },
  { key: 'hyros', label: 'Hyros API', envVar: 'VITE_HYROS_API_KEY', description: 'Pulls revenue attribution, ROAS per campaign' },
  { key: 'fathom', label: 'Fathom API', envVar: 'VITE_FATHOM_API_KEY', description: 'Pulls call transcripts for objection analysis' },
  { key: 'ghl', label: 'GHL Analytics', envVar: 'VITE_GHL_ANALYTICS_URL', description: 'Pipeline funnel, dialer metrics, speed to lead' },
]

export default function SettingsPage() {
  const [syncing, setSyncing] = useState(null)

  const getStatus = (envVar) => {
    const val = import.meta.env[envVar]
    return val && val.length > 0
  }

  const handleSync = async (key) => {
    setSyncing(key)
    // TODO: trigger actual API sync
    await new Promise(r => setTimeout(r, 2000))
    setSyncing(null)
  }

  return (
    <div>
      <h1 className="text-xl font-bold mb-6">Settings</h1>

      <div className="space-y-4">
        <h2 className="text-sm font-medium text-text-secondary">API Connections</h2>

        {apiConfigs.map(api => {
          const connected = getStatus(api.envVar)
          return (
            <div key={api.key} className="bg-bg-card border border-border-default rounded-lg p-4 flex items-center justify-between">
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
    </div>
  )
}
