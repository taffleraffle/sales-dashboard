import { useState } from 'react'
import { Type, Sparkles } from 'lucide-react'
import AdsPhrasesPanel from '../../components/ads/AdsPhrasesPanel'
import AdsIdeationPanel from '../../components/ads/AdsIdeationPanel'

/*
  Messaging page = tab router for two sub-tabs:
    • Phrases    — empirical phrase ranking from ad copy (lib_phrase_performance)
    • Ideation   — Jeremy Haynes Problems × Circumstances × Outcomes generator
                   per (brand × audience archetype), grounded in Daniel's
                   prospect calls + phrase data
*/

const TABS = [
  { id: 'ideation', label: 'Ideation', icon: Sparkles,
    sub: 'Three messaging topics, from real calls' },
  { id: 'phrases',  label: 'Phrases',  icon: Type,
    sub: 'What words actually win' },
]

export default function AdsMessaging() {
  const [tab, setTab] = useState('ideation')

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 mb-5" style={{ borderBottom: '1px solid var(--rule)' }}>
        <div>
          <span className="eyebrow eyebrow-accent">Library · Messaging</span>
          <h2 className="h3 mt-2" style={{ fontSize: 22 }}>The <em>messaging</em> workshop.</h2>
        </div>
      </div>

      {/* Sub-tab bar */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginBottom: 24,
          borderBottom: '1px solid var(--rule)',
        }}
      >
        {TABS.map(t => {
          const active = tab === t.id
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 18px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                fontWeight: 500,
                color: active ? 'var(--ink)' : 'var(--ink-3)',
                background: 'transparent',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
                cursor: 'pointer',
                transition: 'color 160ms ease, border-color 160ms ease',
              }}
            >
              <Icon size={13} />
              <span>{t.label}</span>
              <span
                style={{
                  fontFamily: 'var(--serif)',
                  fontSize: 11,
                  fontStyle: 'italic',
                  letterSpacing: 0,
                  textTransform: 'none',
                  color: 'var(--ink-4)',
                  fontWeight: 400,
                  marginLeft: 6,
                }}
              >
                {t.sub}
              </span>
            </button>
          )
        })}
      </div>

      {tab === 'phrases'  && <AdsPhrasesPanel />}
      {tab === 'ideation' && <AdsIdeationPanel />}
    </div>
  )
}
