// Pulse API client — talks to the ROM-owned review automation system.
//
// Pulse (pulse.rankonmaps.io) is the in-house Cloutly replacement built on the
// taffleraffle/pulse codebase. Multi-tenant Next.js + Supabase + Resend (email)
// + Twilio (SMS, pending). Smart-link 4-5★ → Google, 1-3★ → private feedback.
//
// Each ROM client gets ONE Pulse workspace, identified by client_id in the
// workspace.slug or workspace.metadata. The dashboard creates the workspace
// during client provisioning, then uses these helpers to read/write reviews.
//
// All calls go through PULSE_API_BASE + the workspace-scoped service token.
// Tokens are minted by Pulse during workspace creation and stored on the
// `clients` row in `client_json.pulse.api_token`.

const PULSE_API_BASE = import.meta.env.VITE_PULSE_API_BASE || 'https://pulse.rankonmaps.io/api'
const PULSE_ADMIN_TOKEN = import.meta.env.VITE_PULSE_ADMIN_TOKEN  // for workspace creation

class PulseClient {
  constructor({ token, base = PULSE_API_BASE } = {}) {
    this.token = token || PULSE_ADMIN_TOKEN
    this.base = base
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(opts.headers || {}),
      },
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Pulse API ${res.status} on ${path}: ${errText.slice(0, 300)}`)
    }
    return res.status === 204 ? null : res.json()
  }

  // ── Workspaces (one per ROM client) ────────────────────────────
  async createWorkspace({ name, slug, country_code = 'US', brand_color, brand_logo_url, default_review_url, rom_client_id }) {
    return this._fetch('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, slug, country_code, brand_color, brand_logo_url, default_review_url, metadata: { rom_client_id } }),
    })
  }

  async getWorkspaceBySlug(slug) {
    return this._fetch(`/workspaces/by-slug/${encodeURIComponent(slug)}`)
  }

  // ── Contacts ────────────────────────────────────────────────────
  async uploadContacts(workspaceId, contacts) {
    return this._fetch(`/workspaces/${workspaceId}/contacts/bulk`, {
      method: 'POST',
      body: JSON.stringify({ contacts }),
    })
  }

  // ── Review requests ────────────────────────────────────────────
  async sendReviewRequest({ workspaceId, contactId, channel = 'email', template_key, scheduled_at }) {
    return this._fetch(`/workspaces/${workspaceId}/review-requests`, {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId, channel, template_key, scheduled_at }),
    })
  }

  // ── Read review data (for ROM Reviews tab) ─────────────────────
  async listReviews(workspaceId, { since, until, limit = 50, offset = 0 } = {}) {
    const q = new URLSearchParams()
    if (since) q.set('since', since)
    if (until) q.set('until', until)
    q.set('limit', String(limit))
    q.set('offset', String(offset))
    return this._fetch(`/workspaces/${workspaceId}/reviews?${q}`)
  }

  async getReviewStats(workspaceId, { period_days = 30 } = {}) {
    return this._fetch(`/workspaces/${workspaceId}/stats?days=${period_days}`)
  }

  async listFeedback(workspaceId, { limit = 50 } = {}) {
    return this._fetch(`/workspaces/${workspaceId}/private-feedback?limit=${limit}`)
  }
}

// Singleton for admin-level operations (workspace creation etc.)
export const pulseAdmin = new PulseClient()

// Build a workspace-scoped client (read/write within one client's data)
export function pulseFor(token) {
  return new PulseClient({ token })
}

// Helper: derive a Pulse workspace slug from a ROM client slug.
// Pulse and ROM share slugs, so the URL is predictable.
export function pulseSlugForClient(romClientSlug) {
  return romClientSlug
}
