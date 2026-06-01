// Auto-watch Fathom for new recordings + fire handoff-brief generator.
// Runs every 30 minutes via cron. Polls Fathom for recordings from the last
// 6 hours (handles transient downtime), filters to:
//   - recordings not already in processed_fathom_recordings
//   - recordings with at least one EXTERNAL invitee (not all @rankonmaps.io)
//   - meeting title NOT containing internal-only keywords ("standup", "internal", "1:1", "review")
// For each match, fires handoff-brief to extract promises + scope + ICP.
// If a matching client can be auto-detected (by invitee domain matching client.custom_domain),
// attaches the brief to that client. Otherwise creates an unattached brief
// for Mersad to manually attach via /hq/strategy.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { slackPost } from "../_shared/slack.ts";

const FATHOM_BASE = "https://api.fathom.video/v1";

interface FathomMeeting {
  recording_id: string;
  url?: string;
  share_url?: string;
  title?: string;
  meeting_title?: string;
  start_time?: string;
  end_time?: string;
  host_email?: string;
  invitees?: Array<{ email?: string; name?: string }>;
  duration?: number;
}

interface ClientLookup {
  id: string;
  business_name: string;
  custom_domain: string | null;
  client_json: Record<string, unknown> | null;
}

function isInternalEmail(email: string | undefined): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.endsWith("@rankonmaps.io") || e.endsWith("@rankonmaps.com") || e === "daniel@rankonmaps.io";
}

function isInternalTitle(title: string | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return /\b(standup|stand-up|internal|1:1|one on one|all-hands|team review|retro|retrospective|sprint planning|sync)\b/.test(t);
}

function domainFromEmail(email: string): string {
  return email.split("@")[1]?.toLowerCase() || "";
}

function domainMatches(emailDomain: string, clientDomain: string | null): boolean {
  if (!clientDomain) return false;
  const c = clientDomain.toLowerCase().replace(/^www\./, "");
  return emailDomain === c || emailDomain.endsWith(`.${c}`);
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const fathomKey = Deno.env.get("FATHOM_API_KEY");
  if (!fathomKey) {
    return new Response(JSON.stringify({ error: "FATHOM_API_KEY missing" }), { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const hoursBack = body.hours_back || 6;
  const since = new Date(Date.now() - hoursBack * 3600e3).toISOString();

  // Pull recent Fathom recordings
  const fathomRes = await fetch(`${FATHOM_BASE}/recordings?since=${encodeURIComponent(since)}&limit=50`, {
    headers: { "X-Api-Key": fathomKey },
  });
  if (!fathomRes.ok) {
    return new Response(JSON.stringify({ error: `Fathom ${fathomRes.status}: ${await fathomRes.text()}` }), { status: 500 });
  }
  const fathomData = await fathomRes.json();
  const meetings: FathomMeeting[] = fathomData.recordings || fathomData.meetings || fathomData.data || (Array.isArray(fathomData) ? fathomData : []);

  if (meetings.length === 0) {
    return new Response(JSON.stringify({ ok: true, message: "no new fathom recordings" }), { status: 200 });
  }

  // Pull every client domain once for matching
  const { data: clients } = await supa
    .from("clients")
    .select("id, business_name, custom_domain, client_json");
  const clientList: ClientLookup[] = clients || [];

  const results: Array<{ recording_id: string; status: string; brief_id?: string; client?: string; reason?: string }> = [];

  for (const meeting of meetings) {
    if (!meeting.recording_id) continue;

    // Already processed?
    const { data: existing } = await supa
      .from("processed_fathom_recordings")
      .select("recording_id, status")
      .eq("recording_id", meeting.recording_id)
      .maybeSingle();
    if (existing) {
      results.push({ recording_id: meeting.recording_id, status: "already_processed" });
      continue;
    }

    const title = meeting.title || meeting.meeting_title || "";
    if (isInternalTitle(title)) {
      await supa.from("processed_fathom_recordings").insert({
        recording_id: meeting.recording_id,
        fathom_url: meeting.url || meeting.share_url,
        meeting_title: title,
        call_date: meeting.start_time,
        invitees: meeting.invitees || [],
        status: "skipped",
        reason_skipped: "internal_title",
      });
      results.push({ recording_id: meeting.recording_id, status: "skipped", reason: "internal_title" });
      continue;
    }

    // Need at least one external invitee
    const externalInvitees = (meeting.invitees || []).filter((i) => i.email && !isInternalEmail(i.email));
    if (externalInvitees.length === 0) {
      await supa.from("processed_fathom_recordings").insert({
        recording_id: meeting.recording_id,
        fathom_url: meeting.url || meeting.share_url,
        meeting_title: title,
        call_date: meeting.start_time,
        invitees: meeting.invitees || [],
        status: "skipped",
        reason_skipped: "no_external_invitees",
      });
      results.push({ recording_id: meeting.recording_id, status: "skipped", reason: "no_external_invitees" });
      continue;
    }

    // Try to auto-match a client by invitee domain
    let matchedClient: ClientLookup | null = null;
    for (const inv of externalInvitees) {
      const dom = domainFromEmail(inv.email!);
      const match = clientList.find((c) => domainMatches(dom, c.custom_domain));
      if (match) { matchedClient = match; break; }
    }

    // If we matched a client, fire handoff-brief with client_id. Otherwise skip (no point processing without a target).
    if (!matchedClient) {
      await supa.from("processed_fathom_recordings").insert({
        recording_id: meeting.recording_id,
        fathom_url: meeting.url || meeting.share_url,
        meeting_title: title,
        call_date: meeting.start_time,
        invitees: meeting.invitees || [],
        status: "skipped",
        reason_skipped: "no_client_match",
      });
      results.push({ recording_id: meeting.recording_id, status: "skipped", reason: "no_client_match" });
      continue;
    }

    // Fire handoff-brief
    try {
      const briefRes = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/handoff-brief`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: matchedClient.id,
          fathom_recording_id: meeting.recording_id,
          fathom_url: meeting.url || meeting.share_url,
          closer_name: meeting.host_email ? meeting.host_email.split("@")[0] : "Daniel Girmay",
        }),
      });
      const briefData = await briefRes.json();

      if (briefRes.ok && briefData.brief_id) {
        await supa.from("processed_fathom_recordings").insert({
          recording_id: meeting.recording_id,
          fathom_url: meeting.url || meeting.share_url,
          brief_id: briefData.brief_id,
          client_id: matchedClient.id,
          meeting_title: title,
          call_date: meeting.start_time,
          invitees: meeting.invitees || [],
          attached_client: true,
          status: "attached",
        });

        // Slack notify
        const channel = Deno.env.get("SLACK_CHANNEL_STRATEGY") || "C0B7M5EF9MJ";
        await slackPost(channel, [
          { type: "section", text: { type: "mrkdwn", text: `:scroll: *HANDOFF BRIEF READY* · ${matchedClient.business_name}` } },
          { type: "section", text: { type: "mrkdwn", text: `\`call         \`  ${title}\n\`recording   \`  <${meeting.url || meeting.share_url}|Fathom>\n\`brief       \`  ${briefData.brief_id}` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Review in HQ" }, url: "https://hq.rankonmaps.io/hq/strategy", style: "primary" }] },
        ], `Handoff brief: ${matchedClient.business_name} · ${title}`);

        results.push({ recording_id: meeting.recording_id, status: "attached", brief_id: briefData.brief_id, client: matchedClient.business_name });
      } else {
        await supa.from("processed_fathom_recordings").insert({
          recording_id: meeting.recording_id,
          fathom_url: meeting.url || meeting.share_url,
          meeting_title: title,
          call_date: meeting.start_time,
          client_id: matchedClient.id,
          invitees: meeting.invitees || [],
          status: "errored",
          reason_skipped: briefData.error || `handoff-brief ${briefRes.status}`,
        });
        results.push({ recording_id: meeting.recording_id, status: "errored", reason: briefData.error });
      }
    } catch (e) {
      await supa.from("processed_fathom_recordings").insert({
        recording_id: meeting.recording_id,
        fathom_url: meeting.url || meeting.share_url,
        meeting_title: title,
        call_date: meeting.start_time,
        invitees: meeting.invitees || [],
        status: "errored",
        reason_skipped: (e as Error).message,
      });
      results.push({ recording_id: meeting.recording_id, status: "errored", reason: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ ok: true, scanned: meetings.length, results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
