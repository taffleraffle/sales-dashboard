// site-provisioning — async dispatcher for new client site provisioning.
//
// Trigger: HTTP POST {
//   client_id, fathom_recording_id?, fathom_url?, extra_context?,
//   domain_apex?, cloudflare_project_name?, dry_run?, prefetched_transcript?,
//   webhook_url? (optional, fired on terminal status)
// }
//
// Flow (changed 2026-06 to async/background — the Anthropic call alone can
// run 30-90s which exceeds the edge-function request timeout):
//   1. validate client_id, load the client row
//   2. write a "pending" row into site_provisioning_runs with the full request
//      payload (so the worker can pick it up without re-receiving args)
//   3. fire-and-forget POST to site-provisioning-extract with { run_id }
//   4. return 202 Accepted with run_id + status_url for polling
//
// Polling: GET site-provisioning-status?run_id=...
// Status lifecycle: pending → extracting → extracted → repo_created → deployed
//                                                   ↳ failed (terminal)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function functionsBase(): string {
  // SUPABASE_URL is the rest base, e.g. https://<ref>.supabase.co
  // Functions live at https://<ref>.functions.supabase.co
  try {
    const u = new URL(SUPABASE_URL);
    const ref = u.host.split(".")[0];
    return `https://${ref}.functions.supabase.co`;
  } catch {
    return SUPABASE_URL.replace(".supabase.co", ".functions.supabase.co");
  }
}

async function fireAndForgetExtract(runId: string): Promise<void> {
  const url = `${functionsBase()}/site-provisioning-extract`;
  // We deliberately do NOT await the response. The extract fn can run for
  // 30-90s. Holding the request open here would defeat the purpose of going
  // async. We start the fetch and let it run in the background.
  const p = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "apikey": SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ run_id: runId }),
  }).then((r) => {
    console.log(`extract dispatch -> ${r.status}`);
  }).catch((e) => {
    console.warn(`extract dispatch error: ${(e as Error).message}`);
  });

  // Give the network handoff a few hundred ms to actually transmit before the
  // dispatcher request ends and Deno tears down the isolate.
  // Deno.serve isolates use `waitUntil` semantics implicitly when promises
  // are still in flight at response time, but adding a small grace window
  // makes the handoff reliable in practice.
  // We don't await `p`, just give the runtime a chance to start the request.
  await Promise.race([
    p,
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const {
      client_id,
      fathom_recording_id,
      fathom_url,
      extra_context,
      domain_apex,
      cloudflare_project_name,
      dry_run,
      prefetched_transcript,
      webhook_url,
    } = body || {};

    if (!client_id) {
      return new Response(JSON.stringify({ error: "client_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // validate client exists before queuing work
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id, business_name")
      .eq("id", client_id)
      .maybeSingle();
    if (clientErr || !client) {
      return new Response(JSON.stringify({ error: "client not found", detail: clientErr?.message }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // persist full request payload so the worker can pick it up
    const requestPayload = {
      fathom_recording_id: fathom_recording_id || null,
      fathom_url: fathom_url || null,
      extra_context: extra_context || null,
      domain_apex: domain_apex || null,
      cloudflare_project_name: cloudflare_project_name || null,
      dry_run: !!dry_run,
      prefetched_transcript: prefetched_transcript || null,
    };

    const { data: runRow, error: runInsertErr } = await supabase
      .from("site_provisioning_runs")
      .insert({
        client_id,
        status: "pending",
        fathom_recording_id: fathom_recording_id || null,
        request_payload: requestPayload,
        webhook_url: webhook_url || null,
        error_message: null,
      })
      .select("id")
      .single();

    if (runInsertErr || !runRow) {
      return new Response(
        JSON.stringify({ error: "could not enqueue run", detail: runInsertErr?.message }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
      );
    }

    const runId = runRow.id;
    const statusUrl = `${functionsBase()}/site-provisioning-status?run_id=${runId}`;

    // kick off the worker without waiting for it to finish
    await fireAndForgetExtract(runId);

    return new Response(
      JSON.stringify({
        run_id: runId,
        status: "pending",
        status_url: statusUrl,
        message: "extraction running in background — poll status_url for progress",
      }),
      {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "Location": statusUrl,
          ...corsHeaders,
        },
      },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    console.error("site-provisioning dispatch failed:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
});
