// HUGO Slack events listener (STUB)
// Requires SLACK_SIGNING_SECRET to verify incoming events.
// When the secret is set, this will:
//   - Verify Slack request signature
//   - Handle url_verification challenge
//   - Route message events to ack/respond handlers
//   - Route app_mention events to Anthropic acknowledgment agent
//
// Configure Slack app event subscriptions to POST to:
//   https://nktbnavvehmdqdlpnusu.supabase.co/functions/v1/hugo-events

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost } from "../_shared/slack.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ACK_SYSTEM = `You are HUGO, the Slack ops agent for Rank On Maps. A client just messaged in their shared channel. Your job: reply with a short ack that buys the human team 15-60 minutes of grace.

Voice: Daniel Girmay's tone. Lowercase, terse, dollar-specific. No em-dashes. No AI slop. No "Welcome back" or "let me know if I can help".

Examples of good acks:
- "got you. circling back on this within the hour with the data pulled."
- "noted. mersad picks it up after lunch, will have an answer by 3."
- "yep, on it. dropping the suburbs cut in here within 30."

Output ONLY the ack text. No greeting. No sign-off.`;

async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  const secret = Deno.env.get("SLACK_SIGNING_SECRET");
  if (!secret) return false; // listener disabled

  const ts = req.headers.get("x-slack-request-timestamp");
  const sig = req.headers.get("x-slack-signature");
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(ts, 10)) > 300) return false;

  const basestring = `v0:${ts}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const buf = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `v0=${hex}`;
  return expected === sig;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const body = await req.text();
  let evt: { type?: string; challenge?: string; event?: { type?: string; channel?: string; user?: string; text?: string; bot_id?: string; ts?: string } };
  try { evt = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }

  // url_verification handshake (Slack requires this on app config)
  if (evt.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: evt.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sigOk = await verifySlackSignature(req, body);
  if (!sigOk) {
    return new Response(JSON.stringify({ ok: false, error: "signature_invalid_or_secret_missing" }), { status: 401 });
  }

  const event = evt.event;
  if (!event) return new Response(JSON.stringify({ ok: true, ignored: true }), { status: 200 });

  // Ignore bot messages (prevent loops)
  if (event.bot_id) return new Response(JSON.stringify({ ok: true, ignored: "bot" }), { status: 200 });

  // Match channel to a client
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  if (event.type === "app_mention" || event.type === "message") {
    const { data: client } = await supa
      .from("clients")
      .select("id, business_name, primary_city, vertical")
      .or(`client_slack_channel_id.eq.${event.channel},internal_slack_channel_id.eq.${event.channel}`)
      .maybeSingle();

    if (!client) {
      return new Response(JSON.stringify({ ok: true, ignored: "no_client_match" }), { status: 200 });
    }

    // Log the message
    await supa.from("client_communications").insert({
      client_id: client.id,
      channel: "slack",
      direction: "inbound",
      body: event.text || "",
      source_id: event.ts,
      happened_at: new Date().toISOString(),
    });

    // Generate ack via Anthropic
    try {
      const res = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 200,
          system: ACK_SYSTEM,
          messages: [{ role: "user", content: `Client: ${client.business_name} (${client.vertical}, ${client.primary_city}).\nThey just said: "${event.text}"\n\nGive them an ack.` }],
        }),
      });
      const data = await res.json();
      const ack = data.content?.[0]?.text?.trim();
      if (ack) {
        await slackPost(event.channel!, [
          { type: "section", text: { type: "mrkdwn", text: ack } },
        ], ack);
      }
    } catch (e) {
      console.error("ack generation failed:", e);
    }
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
