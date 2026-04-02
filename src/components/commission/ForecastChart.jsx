import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'

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
    // Expected: sum monthly_amount for active clients (not churned) with payment_count < 4
    const expected = clients
      .filter(c => c.stage !== 'churned' && (c.payment_count || 0) < 4)
      .reduce((sum, c) => sum + Number(c.monthly_amount || 0), 0)

    // Actual: sum net_amount from payments in this month
    const actual = payments
      .filter(p => p.payment_date?.startsWith(m.key))
      .reduce((sum, p) => sum + Number(p.net_amount || 0), 0)

    return { month: m.label, expected: Math.round(expected), actual: Math.round(actual) }
  })

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-bg-card border border-border-default rounded-xl px-3 py-2 shadow-lg text-xs">
        <p className="text-text-primary font-medium mb-1">{label}</p>
        {payload.map(p => (
          <p key={p.dataKey} style={{ color: p.color }}>
            {p.name}: ${p.value.toLocaleString()}
          </p>
        ))}
      </div>
    )
  }

  return (
    <div className="bg-bg-card border border-border-default rounded-2xl p-4 mt-4">
      <h3 className="text-xs font-medium text-text-secondary mb-3">Revenue Forecast — Expected vs Actual</h3>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} barGap={4}>
          <XAxis dataKey="month" tick={{ fill: '#606060', fontSize: 10 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#606060', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 10, color: '#a0a0a0' }}
            formatter={(value) => <span style={{ color: '#a0a0a0' }}>{value}</span>}
          />
          <Bar dataKey="expected" name="Expected" fill="rgba(212, 245, 12, 0.25)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="actual" name="Actual" fill="#d4f50c" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
