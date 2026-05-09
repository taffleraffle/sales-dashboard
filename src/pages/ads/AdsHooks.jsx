import ComponentTable from '../../components/ads/ComponentTable'

export default function AdsHooks() {
  return (
    <ComponentTable
      type="hook"
      title="Hooks"
      emptyHint="No hooks in the library yet. Per the OPT-MetaAd-Naming-SOP, hooks are scripted-content-specific and need real script_text — added via the dashboard or directly in library.components."
    />
  )
}
