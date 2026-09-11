/* The closer's tool stack, in the order of a working day. URLs come from the
   staff-provisioning catalog and the Closer University SOPs (C2-02, C2-05,
   C2-06, C3-01..05). Semrush is the one shared login; the hub fetches it from
   the backend, it is never written here. */
export const CLOSER_TOOLS = [
  { key: 'ghl', name: 'GoHighLevel', url: 'https://app.gohighlevel.com/', what: 'The pipeline. Calls, texts and emails from the card. Move the card at close.' },
  { key: 'wavv', name: 'WAVV', url: 'https://app.wavv.com/', what: 'Power-dial a whole stage off the GHL board. One seat per closer.' },
  { key: 'linq', name: 'LINQ', url: 'https://www.linqapp.com/', what: 'Blue-bubble texts and the group chat with the setter.' },
  { key: 'fathom', name: 'Fathom', url: 'https://fathom.video/home', what: 'Records the call. Drop the transcript on the client for the account manager.' },
  { key: 'semrush', name: 'Semrush', url: 'https://www.semrush.com/multilogin/?redirect_to=%2F', what: 'The prospect audit: keywords, rankings, site health.', shared: true },
  { key: 'lbm', name: 'Local Brand Manager', url: 'https://app.localbrandmanager.com/sign_in', what: 'Map-pack heatmap for the audit and the pitch.' },
  { key: 'pandadoc', name: 'PandaDoc', url: 'https://app.pandadoc.com/', what: 'Agreements. Or make one from the form below.' },
  { key: 'commas', name: 'Commas (FanBasis)', url: 'https://www.fanbasis.com/', what: 'Take payment live on the call. Stripe only if Commas will not work for them.' },
  { key: 'calendly', name: 'Calendly', url: 'https://calendly.com/', what: 'Inbound audit bookings from go.optdigital.io/book-a-call.' },
  { key: 'gcal', name: 'Google Calendar', url: 'https://calendar.google.com/', what: 'Confirm your own calls each morning. Green, yellow, red.' },
  { key: 'slack', name: 'Slack', url: 'https://app.slack.com/', what: '#new-clients, the client channels, the AM team.' },
  { key: 'eod', name: 'End of Day', url: '/sales/eod', internal: true, what: 'Log every call before you finish. Closes only count once they are in.' },
  { key: 'script', name: 'Closing Script + FAQ', url: 'https://docs.google.com/document/d/1LKJU_uy95guPmFpbt7dYt3TI9wyWeVk3tMz6znbizuU/edit', what: 'The full closing script and the objection answers.' },
  { key: 'onboarding', name: 'Onboarding form', url: 'https://onboard.optdigital.io/onboardingwd', what: 'Send it after payment. Pre-fill what you can.' },
  { key: 'university', name: 'Closer University', url: 'https://opt-team-hub.onrender.com/university.html?role=closer', what: 'Every SOP: the offer, the audit, the call, the close.' },
  { key: 'assignments', name: 'Client dashboard', url: 'https://dashboard.optdigital.io/company/assignments', what: 'Assignments: the AM picks up the client here.' },
]
