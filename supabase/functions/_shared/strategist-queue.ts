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

export interface StrategistNotice {
  queue_id: string;
  kind_label: string;        // "BRIEF READY", "AI VISIBILITY", "ROADMAP", etc
  emoji: string;             // ":memo:", ":eyes:", ":compass:"
  client_name: string;
  client_location?: string;
  rows: Array<{ label: string; value: string }>;
  preview?: string;          // long-form excerpt below the table
  cta_label?: string;        // default "Review at hq.rankonmaps.io/hq/strategy"
  urgency?: "low" | "med" | "high";
}

export async function notifyStrategistSlack(notice: StrategistNotice): Promise<void> {
  const token = Deno.env.get("SLACK_BOT_TOKEN");
  const channel = Deno.env.get("SLACK_CHANNEL_STRATEGY") || "C0B7M5EF9MJ";
  if (!token) return;

  const urgencyTag = notice.urgency === "high" ? " · HIGH" : notice.urgency === "low" ? "" : "";
  const locationStr = notice.client_location ? ` · ${notice.client_location}` : "";

  // Build the receipt-style row block
  const maxLabel = Math.max(...notice.rows.map((r) => r.label.length));
  const tableLines = notice.rows
    .map((r) => `\`${r.label.padEnd(maxLabel)}\`  ${r.value}`)
    .join("\n");

  const headerText = `${notice.emoji} *${notice.kind_label}${urgencyTag}* · *${notice.client_name}*${locationStr}`;

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: headerText } },
    { type: "section", text: { type: "mrkdwn", text: tableLines } },
  ];

  if (notice.preview) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `> ${notice.preview.replace(/\n/g, "\n> ")}`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: notice.cta_label || "Review in HQ", emoji: false },
        url: `https://hq.rankonmaps.io/hq/strategy`,
        style: notice.urgency === "high" ? "primary" : undefined,
      },
    ],
  });

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `queue.id \`${notice.queue_id}\`` },
    ],
  });

  // Fallback text for notifications
  const fallback = `${notice.kind_label} · ${notice.client_name} · ${notice.rows[0]?.value || ""}`;

  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel,
        text: fallback,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
  } catch (e) {
    console.error("strategist notify failed:", e);
  }
}
