const presets = [
  { label: 'Today', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: 'MTD', days: 'mtd' },
]

export default function DateRangeSelector({ selected, onChange }) {
  return (
    <div className="flex gap-1">
      {presets.map(({ label, days }) => (
        <button
          key={label}
          onClick={() => onChange(days)}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            selected === days
              ? 'bg-opt-yellow text-bg-primary'
              : 'bg-bg-card text-text-secondary hover:text-text-primary border border-border-default'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
