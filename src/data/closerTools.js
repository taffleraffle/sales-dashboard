/* The closer's apps, in the order of a working day. Kept to what a closer
   opens on a call: Ben, 12 Sep 2026, "I don't need to have Calendly, Google
   links ... all of that there." URLs come from the staff-provisioning catalog
   and the Closer University SOPs. Semrush is the one shared login; the hub
   fetches it from the backend, it is never written here. `chip` is the
   letter tile drawn beside the name (SVG line icons and letters, never emoji). */
export const CLOSER_TOOLS = [
  { key: 'ghl', chip: 'GH', name: 'GoHighLevel', url: 'https://app.gohighlevel.com/', what: 'The pipeline. Move the card at close.' },
  { key: 'wavv', chip: 'W', name: 'WAVV', url: 'https://app.wavv.com/', what: 'Power-dial a stage off the board.' },
  { key: 'linq', chip: 'L', name: 'LINQ', url: 'https://www.linqapp.com/', what: 'Blue-bubble texts and the group chat.' },
  { key: 'fathom', chip: 'F', name: 'Fathom', url: 'https://fathom.video/home', what: 'Records the call for the account manager.' },
  { key: 'semrush', chip: 'S', name: 'Semrush', url: 'https://www.semrush.com/multilogin/?redirect_to=%2F', what: 'The prospect audit.', shared: true },
  { key: 'lbm', chip: 'LB', name: 'Local Brand Manager', url: 'https://app.localbrandmanager.com/sign_in', what: 'Map-pack heatmap for the pitch.' },
  { key: 'pandadoc', chip: 'PD', name: 'PandaDoc', url: 'https://app.pandadoc.com/', what: 'Agreements. New deal drafts one for you.' },
  { key: 'commas', chip: 'C', name: 'Commas', url: 'https://www.fanbasis.com/', what: 'Take payment live on the call.' },
  { key: 'slack', chip: 'SL', name: 'Slack', url: 'https://app.slack.com/', what: '#new-clients and the client channels.' },
  { key: 'eod', chip: 'EOD', name: 'End of Day', url: '/sales/eod', internal: true, what: 'Log every call before you finish.' },
]
