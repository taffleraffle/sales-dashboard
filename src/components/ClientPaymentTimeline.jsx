import { X } from 'lucide-react'

const TYPE_COLORS = {
  trial: { bg: 'bg-blue-500', ring: 'ring-blue-500/30', text: 'text-blue-400' },
  monthly: { bg: 'bg-opt-yellow', ring: 'ring-opt-yellow/30', text: 'text-opt-yellow' },
  ascension: { bg: 'bg-opt-yellow', ring: 'ring-opt-yellow/30', text: 'text-opt-yellow' },
  recurring: { bg: 'bg-success', ring: 'ring-success/30', text: 'text-success' },
  pif: { bg: 'bg-purple-500', ring: 'ring-purple-500/30', text: 'text-purple-400' },
  one_time: { bg: 'bg-text-400', ring: 'ring-text-400/30', text: 'text-text-400' },
}

export default function ClientPaymentTimeline({ client, payments, onClose }) {
  if (!client) return null

  const clientPayments = payments
    .filter(p => p.client_id === client.id)
    .sort((a, b) => new Date(a.payment_date) - new Date(b.payment_date))

  const totalCollected = clientPayments.reduce((s, p) => s + Number(p.net_amount || 0), 0)
  const remaining = Math.max(0, 4 - (client.payment_count || 0))
  const expectedRemaining = remaining * Number(client.monthly_amount || 0)

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
        <div className="tile tile-feedback shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col slide-in-right" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border-default">
            <div>
              <h2 className="text-sm font-bold text-text-primary">{client.name}</h2>
              <p className="text-[10px] text-text-400">{client.company_name || ''} — Payment Timeline</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl flex items-center justify-center text-text-400 hover:text-text-primary hover:bg-bg-card-hover transition-all">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {clientPayments.length === 0 ? (
              <p className="text-text-400 text-xs text-center py-8">No payments recorded for this client</p>
            ) : (
              <div className="relative pl-6">
                {/* Vertical line */}
                <div className="absolute left-[9px] top-2 bottom-2 w-0.5 bg-border-default" />

                {clientPayments.map((p, i) => {
                  const colors = TYPE_COLORS[p.payment_type] || TYPE_COLORS.one_time
                  return (
                    <div key={p.id} className="relative mb-6 last:mb-0">
                      {/* Node */}
                      <div className={`absolute -left-6 top-0.5 w-[18px] h-[18px] rounded-full ${colors.bg} ring-4 ${colors.ring} flex items-center justify-center`}>
                        <span className="text-[8px] font-bold text-bg-primary">{i + 1}</span>
                      </div>

                      {/* Content */}
                      <div className="bg-bg-primary border border-border-default rounded-xl p-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-text-400">
                            {new Date(p.payment_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                          <span className={`inline-flex px-2 py-0.5 rounded text-[9px] font-medium border capitalize ${
                            p.source === 'stripe' ? 'bg-purple-500/15 text-purple-400 border-purple-500/30' :
                            p.source === 'fanbasis' ? 'bg-blue-500/15 text-blue-400 border-blue-500/30' :
                            'bg-text-400/15 text-text-400 border-text-400/30'
                          }`}>{p.source}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-medium capitalize ${colors.text}`}>{p.payment_type || 'payment'}</span>
                          <span className="text-sm font-bold text-success">${Number(p.net_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        </div>
                        {p.description && (
                          <p className="text-[10px] text-text-400 mt-1">{p.description}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-border-default flex items-center justify-between">
            <div>
              <span className="text-[10px] text-text-400 uppercase tracking-wider">Total Collected</span>
              <p className="text-sm font-bold text-success">${totalCollected.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            {expectedRemaining > 0 && (
              <div className="text-right">
                <span className="text-[10px] text-text-400 uppercase tracking-wider">Expected Remaining</span>
                <p className="text-sm font-bold text-opt-yellow">${expectedRemaining.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
