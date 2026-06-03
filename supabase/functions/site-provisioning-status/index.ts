// site-provisioning-status — poll endpoint for an async site-provisioning run.
//
// Trigger: HTTP GET or POST { run_id }  (or ?run_id=... as querystring)
//
// Returns the current row state from site_provisioning_runs. Use this to poll
// after receiving a 202 Accepted from /site-provisioning.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  try {
    let runId: string | null = null;
    if (req.method === "GET") {
      const url = new URL(req.url);
      runId = url.searchParams.get("run_id");
    } else if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      runId = body?.run_id || null;
    } else {
      return new Response("method not allowed", { status: 405, headers: corsHeaders });
    }

    if (!runId) {
      return new Response(JSON.stringify({ error: "run_id required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const { data: row, error } = await supabase
      .from("site_provisioning_runs")
      .select("id, client_id, status, fathom_recording_id, repo_name, repo_url, extraction_notes, error_message, created_at, updated_at")
      .eq("id", runId)
      .maybeSingle();

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    if (!row) {
      return new Response(JSON.stringify({ error: "run not found", run_id: runId }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const terminal = row.status === "deployed" || row.status === "failed";
    return new Response(
      JSON.stringify({
        run_id: row.id,
        client_id: row.client_id,
        status: row.status,
        terminal,
        fathom_recording_id: row.fathom_recording_id,
        repo_name: row.repo_name,
        repo_url: row.repo_url,
        extraction_notes: row.extraction_notes,
        error_message: row.error_message,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});
