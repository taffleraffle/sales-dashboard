const statusColors = {
  set: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  showed: 'bg-opt-yellow-muted text-opt-yellow border-opt-yellow/30',
  closed: 'bg-success/15 text-success border-success/30',
  no_show: 'bg-danger/15 text-danger border-danger/30',
  not_closed: 'bg-text-400/15 text-text-400 border-text-400/30',
  rescheduled: 'bg-warning/15 text-warning border-warning/30',
  cancelled: 'bg-danger/15 text-danger border-danger/30',
  ascended: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
}

const statusLabels = {
  set: 'Set',
  showed: 'Showed',
  closed: 'Closed',
  no_show: 'No Show',
  not_closed: 'Not Closed',
  rescheduled: 'Rescheduled',
  cancelled: 'Cancelled',
  ascended: 'Ascended',
}

export default function LeadStatusBadge({ status }) {
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium border ${statusColors[status] || statusColors.set}`}>
      {statusLabels[status] || status}
    </span>
  )
}
