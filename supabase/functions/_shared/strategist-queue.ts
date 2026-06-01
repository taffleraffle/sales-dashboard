// Routes every AI output through the strategist queue.
// Returns { queue_id }. Caller does NOT publish — queue worker does after approval.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

export type QueueKind =
  | "content_brief"
  | "content_draft"
  | "gbp_post"
  | "citation_target"
  | "weekly_recap_curation"
  | "ai_visibility_report"
  | "roadmap_update"
  | "competitor_brief"
  | "win_curation"
  | "red_flag_review"
  | "health_check_followup";

export interface EnqueueInput {
  client_id: string;
  kind: QueueKind;
  priority?: number;
  proposed_payload: Record<string, unknown>;
  source_function: string;
  source_payload?: Record<string, unknown>;
  strategist_name?: string;
}

export async function enqueueForStrategist(input: EnqueueInput): Promise<{ queue_id: string }> {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await supa
    .from("strategist_queue")
    .insert({
      client_id: input.client_id,
      kind: input.kind,
      priority: input.priority ?? 50,
      proposed_payload: input.proposed_payload,
      source_function: input.source_function,
      source_payload: input.source_payload || {},
      strategist_name: input.strategist_name || "Mersad",
    })
    .select("id")
    .single();

  if (error) throw new Error(`enqueue failed: ${error.message}`);
  return { queue_id: data.id };
}

export async function notifyStrategistSlack(queueId: string, summary: string): Promise<void> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  const channel = Deno.env.get("SLACK_CHANNEL_STRATEGY") || "C0B1QJJ1BT2";
  if (!token) return;
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        text: summary,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:mag: *Strategist queue:* ${summary}\n_Review at hq.rankonmaps.io/strategy_` } },
          { type: "context", elements: [{ type: "mrkdwn", text: `queue.id ${queueId}` }] },
        ],
        unfurl_links: false,
      }),
    });
  } catch (e) {
    console.error("strategist notify failed:", e);
  }
}
