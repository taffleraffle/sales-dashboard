/* The closer's apps, in the order of a working day. Kept to what a closer
   opens on a call: Ben, 12 Sep 2026, "I don't need to have Calendly, Google
   links ... all of that there." URLs come from the staff-provisioning catalog
   and the Closer University SOPs. Semrush and Local Brand Manager are shared logins;
   `shared` names the credential pair the backend holds, nothing is written here. `icon` is the app's own
   logo in public/app-icons; `chip` is the letter fallback (never emoji). */
export const CLOSER_TOOLS = [
  { key: 'ghl', icon: '/app-icons/ghl.png', chip: 'GH', name: 'GoHighLevel', url: 'https://app.gohighlevel.com/', what: 'The pipeline. Move the card at close.' },
  { key: 'wavv', icon: '/app-icons/wavv.png', chip: 'W', name: 'WAVV', url: 'https://app.wavv.com/', what: 'Power-dial a stage off the board.' },
  { key: 'linq', icon: '/app-icons/linq.png', chip: 'L', name: 'LINQ', url: 'https://www.linqapp.com/', what: 'Blue-bubble texts and the group chat.' },
  { key: 'semrush', icon: '/app-icons/semrush.png', chip: 'S', name: 'Semrush', url: 'https://www.semrush.com/multilogin/?redirect_to=%2F', what: 'The prospect audit.', shared: 'semrush' },
  { key: 'lbm', icon: '/app-icons/lbm.png', chip: 'LB', name: 'Local Brand Manager', url: 'https://app.localbrandmanager.com/sign_in', what: 'Map-pack heatmap for the pitch.', shared: 'lbm' },
  { key: 'pandadoc', icon: '/app-icons/pandadoc.png', chip: 'PD', name: 'PandaDoc', url: 'https://app.pandadoc.com/', what: 'Agreements. New deal drafts one for you.' },
  { key: 'commas', icon: '/app-icons/commas.png', chip: 'C', name: 'Commas', url: 'https://www.fanbasis.com/', what: 'Take payment live on the call.' },
  { key: 'slack', icon: '/app-icons/slack.png', chip: 'SL', name: 'Slack', url: 'https://app.slack.com/', what: '#new-clients and the client channels.' },
  { key: 'eod', chip: 'EOD', name: 'End of Day', url: '/sales/eod', internal: true, what: 'Log every call before you finish.' },
]
