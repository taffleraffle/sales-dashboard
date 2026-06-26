import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'

/*
  Editorial bar chart.
  - Track: paper background, hairline rule
  - "Expected" series: paper-2 fill (soft, no glow)
  - "Actual" series: ink fill (primary signal)
  - Axes: mono 10px ink-3, no axis lines, no tick lines
  - Tooltip: ink panel + paper text + accent dot per series
*/

const SERIES = {
  expected: { fill: 'var(--paper-3)', dotColor: 'var(--ink-3)', label: 'Expected' },
  actual:   { fill: 'var(--ink)',     dotColor: 'var(--accent)', label: 'Actual' },
}

export default function ForecastChart({ clients, payments }) {
  const now = new Date()
  const months = []
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    })
  }

  const data = months.map(m => {
    const expected = clients
      .filter(c => c.stage !== 'churned' && (c.payment_count || 0) < 4)
      .reduce((sum, c) => sum + Number(c.monthly_amount || 0), 0)
    const actual = payments
      .filter(p => p.payment_date?.startsWith(m.key))
      .reduce((sum, p) => sum + Number(p.net_amount || 0), 0)
    return { month: m.label, expected: Math.round(expected), actual: Math.round(actual) }
  })

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null
    return (
      <div
        style={{
          background: 'var(--ink)',
          color: 'var(--paper)',
          padding: '8px 10px',
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.04em',
          borderRadius: 9,
          boxShadow: '0 8px 24px rgba(10,10,10,0.16)',
        }}
      >
        <p
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--paper-2)',
            margin: '0 0 4px',
          }}
        >
          {label}
        </p>
        {payload.map(p => {
          const series = SERIES[p.dataKey] || { dotColor: 'var(--accent)' }
          return (
            <div
              key={p.dataKey}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--serif)',
                fontSize: 13,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--paper)',
                margin: '2px 0 0',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: series.dotColor,
                  flexShrink: 0,
                }}
              />
              {p.name}: ${p.value.toLocaleString()}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      className="mt-4"
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--rule)',
        borderRadius: 10,
        padding: 18,
      }}
    >
      <span className="eyebrow eyebrow-accent" style={{ fontSize: 9, marginBottom: 8, display: 'inline-flex' }}>Revenue forecast</span>
      <h3 className="h3 mt-2 mb-4" style={{ fontSize: 17 }}>
        Expected <em>vs</em> actual.
      </h3>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} barGap={6} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
          <XAxis
            dataKey="month"
            tick={{ fill: 'var(--ink-3)', fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--ink-3)', fontSize: 10, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => `$${(v / 1000).toFixed(0)}k`}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--paper-2)' }} />
          <Legend
            wrapperStyle={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--ink-3)',
              paddingTop: 8,
            }}
            iconType="square"
            iconSize={9}
            formatter={(value) => (
              <span style={{ color: 'var(--ink-3)', marginLeft: 4 }}>{value}</span>
            )}
          />
          <Bar dataKey="expected" name="Expected" fill={SERIES.expected.fill} radius={[2, 2, 0, 0]} />
          <Bar dataKey="actual"   name="Actual"   fill={SERIES.actual.fill}   radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
