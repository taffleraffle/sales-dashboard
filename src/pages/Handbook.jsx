import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import handbookSource from '../../HANDBOOK.md?raw'
import { PageShell, BrandedHero, ink, ink2, ink3, hair, hair2, accent } from '../components/ui'

const styles = {
  h1: { fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 800,
        letterSpacing: '-0.04em', color: ink, marginTop: 0, marginBottom: 18, lineHeight: 1.05 },
  h2: { fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700,
        letterSpacing: '-0.028em', color: ink, marginTop: 48, marginBottom: 14,
        paddingBottom: 10, borderBottom: `2px solid var(--color-accent)`, display: 'inline-block' },
  h3: { fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
        letterSpacing: '0.18em', textTransform: 'uppercase', color: accent,
        marginTop: 28, marginBottom: 10 },
  p:  { fontSize: 15, color: ink, lineHeight: 1.65, marginTop: 0, marginBottom: 14,
        letterSpacing: '-0.005em' },
  ul: { fontSize: 15, color: ink, lineHeight: 1.65, paddingLeft: 22, marginBottom: 14 },
  li: { marginBottom: 6 },
  strong: { color: ink, fontWeight: 600 },
  em: { fontFamily: 'var(--font-serif)', color: ink, fontStyle: 'italic',
        letterSpacing: '-0.01em', fontWeight: 400 },
  code: {
    background: 'rgba(31,77,60,0.06)', padding: '2px 6px', borderRadius: 3,
    fontFamily: 'var(--font-mono)', fontSize: 12.5, color: accent, fontWeight: 500,
  },
  hr: { border: 0, borderTop: hair, margin: '40px 0' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18,
           marginTop: 10, background: 'var(--color-bg-alt)', borderRadius: 8, overflow: 'hidden' },
  th: { textAlign: 'left', padding: '12px 14px', fontFamily: 'var(--font-mono)',
        fontSize: 10, fontWeight: 600, color: ink2,
        textTransform: 'uppercase', letterSpacing: '0.14em', borderBottom: hair,
        background: 'rgba(31,77,60,0.04)' },
  td: { padding: '12px 14px', color: ink, borderBottom: hair2, verticalAlign: 'top',
        fontSize: 14 },
  blockquote: {
    borderLeft: `3px solid ${accent}`, paddingLeft: 18, color: ink,
    fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 17,
    letterSpacing: '-0.01em', margin: '16px 0', lineHeight: 1.4,
  },
}

const components = {
  h1: ({ children }) => <h1 style={styles.h1}>{children}</h1>,
  h2: ({ children }) => <h2 style={styles.h2}>{children}</h2>,
  h3: ({ children }) => <h3 style={styles.h3}>{children}</h3>,
  p:  ({ children }) => <p style={styles.p}>{children}</p>,
  ul: ({ children }) => <ul style={styles.ul}>{children}</ul>,
  ol: ({ children }) => <ol style={{ ...styles.ul, listStyle: 'decimal' }}>{children}</ol>,
  li: ({ children }) => <li style={styles.li}>{children}</li>,
  strong: ({ children }) => <strong style={styles.strong}>{children}</strong>,
  em: ({ children }) => <em style={styles.em}>{children}</em>,
  code: ({ inline, children }) => inline
    ? <code style={styles.code}>{children}</code>
    : <pre style={{ ...styles.code, padding: 12, overflow: 'auto', display: 'block', marginBottom: 12 }}>{children}</pre>,
  hr: () => <hr style={styles.hr} />,
  table: ({ children }) => <div style={{ overflowX: 'auto' }}><table style={styles.table}>{children}</table></div>,
  th: ({ children }) => <th style={styles.th}>{children}</th>,
  td: ({ children }) => <td style={styles.td}>{children}</td>,
  blockquote: ({ children }) => <blockquote style={styles.blockquote}>{children}</blockquote>,
  a: ({ href, children }) => <a href={href} style={{ color: accent, textDecoration: 'none' }} target="_blank" rel="noopener noreferrer">{children}</a>,
}

export default function Handbook() {
  return (
    <PageShell>
      <BrandedHero
        eyebrow="SETTER + CLOSER REFERENCE"
        title="Handbook"
        sub="Granular call tracking, offer stack, payment link conventions, and everything you need to know to take a call."
        padBottom={48}
      />
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '40px 28px 80px' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {handbookSource}
        </ReactMarkdown>
      </div>
    </PageShell>
  )
}
