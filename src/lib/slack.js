// Slack client for browser/Node consumers (HQ UI emergency posts, test buttons)
// Routes through Supabase edge function `hugo-relay` to avoid leaking bot token to client bundle

const RELAY_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/hugo-relay`;

export const CLIENT_WINS_CHANNEL = "C09AT5F82FL";

export async function postSlack({ channel, text, blocks, mentionChannel = true }) {
  const token = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(RELAY_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, blocks, mentionChannel }),
  });
  return res.json();
}

export async function postWin({ client_id, kind, headline, detail, payload }) {
  const token = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/emit-win`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id, kind, headline, detail, payload }),
    },
  );
  return res.json();
}
