import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import StatePill from './StatePill'
import KPIBadge, { classifyKPI } from './KPIBadge'

/*
  Editorial ad card — one row of `public.ads` rendered as a clickable tile.
  Card anatomy mirrors the spec in AD-LIBRARY-FUNCTIONS-V3.md §2.3:
    [video preview / thumbnail] (autoplay muted on hover)
    [variant pill + brand chip]
    [headline stats: spend · leads · booked · closed · revenue]
    [CPL · CPA · ROAS]
    [state pill + KPI badge]
*/

function fmt$(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`
  return `$${Math.round(n).toLocaleString()}`
}
function fmtN(n) { return n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString() }
function fmtX(n) { return n == null || isNaN(n) ? '—' : `${n.toFixed(2)}x` }

export default function AdCard({ ad }) {
  const stats = ad.stats || {}
  const spend = stats.spend ?? 0
  const leads = stats.leads ?? 0
  const booked = stats.booked ?? 0
  const closed = stats.closed ?? 0
  const revenue = stats.revenue ?? 0
  const cpl = leads > 0 ? spend / leads : null
  const cpa = closed > 0 ? spend / closed : null
  const cpb = booked > 0 ? spend / booked : null
  const roas = spend > 0 ? revenue / spend : null
  const leadQuality = stats.leadQualityPct ?? null

  const kpiStatus = classifyKPI({
    costPerBooked: cpb,
    costPerClose: cpa,
    leadQualityPct: leadQuality,
  })

  const state = ad.variant_state || ad.status || 'bench'
  const accentColor =
    state === 'winning' ? 'var(--accent)' :
    state === 'foundational' ? 'var(--ink)' :
    state === 'bad_pocket' ? 'var(--down)' :
    state === 'fatigued' ? 'var(--rule)' :
    'var(--rule)'

  return (
    <Link
      to={`/sales/ads/ad/${ad.ad_id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--paper)',
        border: `1px solid var(--rule)`,
        borderLeftWidth: 3,
        borderLeftColor: accentColor,
        borderRadius: 4,
        overflow: 'hidden',
        transition: 'border-color 200ms ease, box-shadow 200ms ease, transform 200ms ease',
        textDecoration: 'none',
        color: 'var(--ink)',
      }}
      onMouseOver={(e) => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.borderLeftColor = accentColor; e.currentTarget.style.boxShadow = '0 4px 16px rgba(10,10,10,0.06)' }}
      onMouseOut={(e) => { e.currentTarget.style.borderColor = 'var(--rule)'; e.currentTarget.style.borderLeftColor = accentColor; e.currentTarget.style.boxShadow = 'none' }}
    >
      {/* Video / thumbnail */}
      <div
        style={{
          position: 'relative',
          aspectRatio: '4 / 5',
          background: 'var(--paper-2)',
          overflow: 'hidden',
        }}
      >
        {ad.thumbnail_url ? (
          <img
            src={ad.thumbnail_url}
            alt={ad.ad_name || 'ad creative'}
            loading="lazy"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ink-4)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}
          >
            No thumbnail
          </div>
        )}
        {/* Play overlay (just visual, click goes to detail) */}
        {ad.video_id && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              padding: '3px 7px',
              background: 'rgba(10,10,10,0.7)',
              color: 'var(--paper)',
              borderRadius: 2,
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Play size={9} fill="currentColor" />
            {ad.duration_sec ? `${Math.round(ad.duration_sec)}s` : 'Video'}
          </div>
        )}
        {/* State + KPI overlay */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            right: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            gap: 4,
          }}
        >
          <StatePill state={state} />
          <KPIBadge status={kpiStatus} />
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
        {/* Variant pill / ad name */}
        <div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9.5,
              letterSpacing: '0.1em',
              color: 'var(--ink-3)',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={ad.variant_id || ad.ad_name}
          >
            {ad.variant_id || ad.ad_name?.slice(0, 60) || 'unparsed'}
          </div>
          {ad.brand && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--ink-4)',
                marginTop: 2,
              }}
            >
              {ad.brand}
            </div>
          )}
        </div>

        {/* Headline stats — 2-row of 3 numbers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {[
            { label: 'Spend',  value: fmt$(spend) },
            { label: 'Booked', value: fmtN(booked) },
            { label: 'Closed', value: fmtN(closed) },
          ].map(s => (
            <Stat key={s.label} label={s.label} value={s.value} />
          ))}
        </div>

        {/* Efficiency — 3 numbers */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 6,
            paddingTop: 8,
            borderTop: '1px solid var(--rule)',
          }}
        >
          {[
            { label: 'CPL',  value: fmt$(cpl) },
            { label: 'CPA',  value: fmt$(cpa) },
            { label: 'ROAS', value: fmtX(roas) },
          ].map(s => (
            <Stat key={s.label} label={s.label} value={s.value} compact />
          ))}
        </div>
      </div>
    </Link>
  )
}

function Stat({ label, value, compact = false }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-3)',
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--serif)',
          fontSize: compact ? 14 : 17,
          lineHeight: 1.05,
          color: 'var(--ink)',
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.01em',
          marginTop: 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={String(value)}
      >
        {value}
      </div>
    </div>
  )
}
