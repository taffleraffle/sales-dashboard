// Win emitter — single entry point for all win-trigger events
// Inserts to wins table + posts to #client-wins with @channel tag

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost, SLACK_CHANNELS } from "./slack.ts";

export type WinKind =
  | "new_lead"
  | "rank_jump"
  | "new_review_5star"
  | "content_indexed"
  | "milestone"
  | "new_client_signed"
  | "gbp_post_traction"
  | "citation_built"
  | "backlink_earned"
  | "serp_feature_won";

export interface EmitWinInput {
  client_id: string;
  kind: WinKind;
  headline: string;
  detail?: string;
  payload?: Record<string, unknown>;
  source?: string;
  postToSlack?: boolean;
  channel?: string;
  mentionChannel?: boolean;
}

const KIND_ICONS: Record<WinKind, string> = {
  new_lead: ":telephone_receiver:",
  rank_jump: ":chart_with_upwards_trend:",
  new_review_5star: ":star2:",
  content_indexed: ":memo:",
  milestone: ":trophy:",
  new_client_signed: ":handshake:",
  gbp_post_traction: ":eyes:",
  citation_built: ":link:",
  backlink_earned: ":satellite_antenna:",
  serp_feature_won: ":sparkles:",
};

function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function emitWin(input: EmitWinInput): Promise<{ id?: string; slack_ts?: string }> {
  const supa = adminClient();

  const { data: client } = await supa
    .from("clients")
    .select("id, business_name, primary_city, vertical")
    .eq("id", input.client_id)
    .maybeSingle();

  const channel = input.channel || SLACK_CHANNELS.CLIENT_WINS;
  const mention = input.mentionChannel === false ? "" : "<!channel> ";
  const icon = KIND_ICONS[input.kind] || ":fire:";
  const clientLabel = client
    ? `*${client.business_name}*${client.primary_city ? ` · ${client.primary_city}` : ""}`
    : "*Unknown client*";

  const fallbackText = `${icon} ${input.headline} — ${clientLabel}`;

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${mention}${icon} *${input.headline}*\n${clientLabel}`,
      },
    },
  ];

  if (input.detail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: input.detail },
    });
  }

  const contextElements: unknown[] = [
    { type: "mrkdwn", text: `\`${input.kind.toUpperCase()}\`` },
  ];
  if (input.source) {
    contextElements.push({ type: "mrkdwn", text: `via ${input.source}` });
  }
  contextElements.push({
    type: "mrkdwn",
    text: `<!date^${Math.floor(Date.now() / 1000)}^{time_secs}|just now>`,
  });

  blocks.push({ type: "context", elements: contextElements });
  blocks.push({ type: "divider" });

  let slack_ts: string | undefined;
  let slack_channel_id: string | undefined;
  if (input.postToSlack !== false) {
    try {
      const result = await slackPost(channel, blocks, fallbackText);
      if (result.ok) {
        slack_ts = result.ts;
        slack_channel_id = result.channel;
      } else {
        console.error("slack post failed:", result.error);
      }
    } catch (e) {
      console.error("slack exception:", (e as Error).message);
    }
  }

  const { data: inserted } = await supa
    .from("wins")
    .insert({
      client_id: input.client_id,
      kind: input.kind,
      headline: input.headline,
      detail: input.detail,
      payload: input.payload || {},
      source: input.source,
      slack_channel_id,
      slack_message_ts: slack_ts,
      slack_posted_at: slack_ts ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  return { id: inserted?.id, slack_ts };
}
