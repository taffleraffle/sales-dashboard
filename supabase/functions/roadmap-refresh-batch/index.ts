// Monthly cron — calls roadmap-generator for every active client
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

serve(async (_req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: clients } = await supa
    .from("clients")
    .select("id, business_name")
    .eq("status", "active");
  if (!clients) return new Response(JSON.stringify({ ok: true, count: 0 }), { status: 200 });

  const results: Array<{ client: string; ok: boolean }> = [];
  for (const client of clients) {
    try {
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/roadmap-generator`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: client.id, force: false }),
      });
      results.push({ client: client.business_name, ok: r.ok });
    } catch (e) {
      results.push({ client: client.business_name, ok: false });
      console.error(e);
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { "Content-Type": "application/json" } });
});
