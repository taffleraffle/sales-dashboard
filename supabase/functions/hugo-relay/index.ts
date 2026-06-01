// Relay endpoint for the HQ UI to post arbitrary messages to Slack via the bot.
// Keeps the bot token out of the client bundle.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { slackPost } from "../_shared/slack.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { channel, text, blocks, mentionChannel } = await req.json();
    const mention = mentionChannel === false ? "" : "<!channel> ";
    const finalBlocks = blocks || [
      { type: "section", text: { type: "mrkdwn", text: `${mention}${text}` } },
    ];
    const result = await slackPost(channel, finalBlocks, text);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
