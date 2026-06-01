// Slack API wrapper for edge functions
// Bot: hermes (App: HUGO) — workspace rankonmaps.slack.com
// Outbound posting only needs SLACK_BOT_TOKEN; incoming events need signing secret (deferred)

const SLACK_API = "https://slack.com/api";

export interface SlackPostResult {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

export async function slackPost(
  channel: string,
  blocks: unknown[],
  fallbackText: string,
): Promise<SlackPostResult> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");

  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text: fallbackText,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  const data = await res.json();
  return data;
}

export async function slackPostSimple(
  channel: string,
  text: string,
  mention: string | null = "<!channel>",
): Promise<SlackPostResult> {
  const body = mention ? `${mention} ${text}` : text;
  return slackPost(channel, [
    { type: "section", text: { type: "mrkdwn", text: body } },
  ], body);
}

export async function slackEnsureChannel(name: string): Promise<string | null> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  if (!token) return null;

  // Try to find first
  const listRes = await fetch(`${SLACK_API}/conversations.list?limit=1000&exclude_archived=true`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const list = await listRes.json();
  const existing = (list.channels || []).find((c: { name: string }) => c.name === name);
  if (existing) return existing.id;

  // Create
  const createRes = await fetch(`${SLACK_API}/conversations.create`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, is_private: false }),
  });
  const created = await createRes.json();
  return created?.channel?.id || null;
}

export const SLACK_CHANNELS = {
  CLIENT_WINS: "C09AT5F82FL",
};
