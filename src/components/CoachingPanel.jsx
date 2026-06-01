import { useObjectionInsights } from '../hooks/useObjectionInsights'
import { Section, fmtPct, ink, ink2, ink3, hair, neg } from './ui'

export default function CoachingPanel({ days = 30 }) {
  const { top, loading } = useObjectionInsights(days)

  if (loading) return null
  if (top.length === 0) return null

  return (
    <Section title="Coaching opportunities" action={<span style={{ fontSize: 11, color: ink3, letterSpacing: '-0.005em' }}>Top objections from Fathom transcripts</span>}>
      <div style={{ display: 'grid', gap: 10 }}>
        {top.map((o, idx) => (
          <div key={o.category} style={{
            border: hair, borderRadius: 8, padding: '14px 16px',
            display: 'grid', gridTemplateColumns: '40px 1fr auto', gap: 14, alignItems: 'start',
          }}>
            <div style={{ fontSize: 22, fontWeight: 600, color: ink3, letterSpacing: '-0.02em' }} className="num">
              {idx + 1}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500, color: ink, letterSpacing: '-0.005em' }}>
                {o.category}
              </div>
              <div style={{ fontSize: 11, color: ink2, marginTop: 2 }}>
                {o.total} occurrence{o.total === 1 ? '' : 's'}
                {o.avgWinRate != null && <> · team avg win rate <span className="num" style={{ color: ink }}>{fmtPct(o.avgWinRate)}</span></>}
              </div>
              {o.exampleQuote && (
                <div style={{
                  marginTop: 8, padding: '8px 12px',
                  background: 'rgba(0,0,0,0.02)', borderLeft: '2px solid var(--color-hairline)',
                  fontSize: 12, color: ink2, fontStyle: 'italic', letterSpacing: '-0.005em',
                }}>
                  "{String(o.exampleQuote).slice(0, 180)}{String(o.exampleQuote).length > 180 ? '…' : ''}"
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              {o.coachingCandidate ? (
                <>
                  <div style={{ fontSize: 11, color: ink3, letterSpacing: '-0.005em' }}>Coach</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: ink, marginTop: 2 }}>
                    {o.coachingCandidate.closerName}
                  </div>
                  {o.coachingCandidate.winRate != null && (
                    <div style={{ fontSize: 11, color: neg, marginTop: 2 }} className="num">
                      {fmtPct(o.coachingCandidate.winRate)} win
                    </div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 11, color: ink3 }}>—</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
