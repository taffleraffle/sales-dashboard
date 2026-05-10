import { Link } from 'react-router-dom'

// Renders a variant_id (e.g. "H4.2_BA-PROOF_S-OFFICE_OSO_v1") as a clickable
// pill that decomposes into its four component IDs. When variantId is null
// (ad isn't linked to a variant), shows status-aware fallback.
export default function VariantPill({ variantId, matchStatus, compact = false }) {
  if (!variantId) {
    const tone = matchStatus === 'orphan'
      ? 'text-danger border-danger/30 bg-danger/10'
      : matchStatus === 'unparsed'
      ? 'text-text-400 border-border-default bg-bg-card-hover'
      : 'text-text-400 border-border-default bg-bg-card-hover'
    const label = matchStatus === 'orphan' ? 'Orphan' : matchStatus === 'legacy' ? 'Legacy' : matchStatus === 'unparsed' ? 'Unparsed' : 'Pending'
    return (
      <span className={`text-[9px] uppercase tracking-wider font-medium px-1.5 py-0.5 rounded border ${tone}`}>
        {label}
      </span>
    )
  }

  if (compact) {
    return (
      <Link
        to={`/sales/ads/variants/${encodeURIComponent(variantId)}`}
        className="text-[9px] font-mono text-text-primary hover:underline truncate"
        title={variantId}
      >
        {variantId}
      </Link>
    )
  }

  // Decompose for the full pill view
  const parts = variantId.split('_')
  const [hook, body, scene, creator, version] = parts

  return (
    <Link
      to={`/sales/ads/variants/${encodeURIComponent(variantId)}`}
      className="inline-flex items-center gap-1 text-[9px] font-mono group"
      title={variantId}
    >
      {hook && <span className="px-1.5 py-0.5 rounded border border-opt-yellow/30 text-text-primary group-hover:bg-opt-yellow/10">{hook}</span>}
      {body && <span className="px-1.5 py-0.5 rounded border border-border-default text-text-secondary group-hover:bg-bg-card-hover">{body}</span>}
      {scene && <span className="px-1.5 py-0.5 rounded border border-border-default text-text-secondary group-hover:bg-bg-card-hover">{scene}</span>}
      {creator && <span className="px-1.5 py-0.5 rounded border border-border-default text-text-secondary group-hover:bg-bg-card-hover">{creator}</span>}
      {version && <span className="text-text-400 text-[8px]">{version}</span>}
    </Link>
  )
}
