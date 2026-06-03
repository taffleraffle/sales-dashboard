// integrity-runner — executes every enabled integrity_checks row, records
// findings, opens/resolves issues, posts a digest to #rom-internal-ops.
//
// Cron fires this every 6h. Today's template-deploy-spam (hardcoded project-name,
// missing secrets, push trigger active) should never have shipped — this sweep
// is the safety net.
//
// POST body: { check_keys?: string[], dry_run?: boolean, triggered_by?: 'cron'|'manual'|'api' }
//   - check_keys: filter to a subset (omit to run all enabled)
//   - dry_run: skip writes to integrity_runs/integrity_findings + skip Slack
//
// Dispatcher matrix:
//   sql           → run SQL via direct pg connection, compare result to expected
//   api_fetch     → HTTP request, assert status + optional body shape
//   cross_compare → pull from 2+ sources via SQL/HTTP, deep-compare
//   shell         → CANNOT run in edge fn. Recorded as 'inconclusive',
//                   logged to needs_external_runner. A local launchd / GH Action
//                   runner picks these up and POSTs results back.
//
// Auto-fix: SAFE OPS ONLY. Auto-fix lane (separate fn) opens a PR, never merges.
// This runner only records — it does not mutate target systems.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (write findings/runs)
//   SUPABASE_DB_URL                          (direct pg for arbitrary SQL checks)
//   SLACK_BOT_TOKEN                          (digest post)
//   SLACK_INTERNAL_OPS_CHANNEL               (defaults to #rom-internal-ops)
//   CRON_SECRET                              (auth gate for cron)
//
// Deploy: npx supabase functions deploy integrity-runner --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";
import { Client as PgClient } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { handleCors, getCorsHeaders } from "../_shared/cors.ts";
import { postSlackBySeverity } from "../_shared/slack-channels.ts";

// INTERNAL_OPS_CHANNEL removed — Slack routing now goes through slack_channel_registry
// via _shared/slack-channels.ts (severity-routed).

type Severity = "critical" | "fail" | "warn" | "inconclusive";
type CheckKind = "sql" | "shell" | "api_fetch" | "cross_compare";

interface IntegrityCheckRow {
  id: string;
  key: string;
  title: string;
  category: string;
  severity_on_fail: "critical" | "fail" | "warn";
  check_kind: CheckKind;
  check_definition: Record<string, unknown>;
  expected: Record<string, unknown> | null;
  enabled: boolean;
}

interface CheckResult {
  check_key: string;
  passed: boolean;
  severity: Severity;
  target: string;
  evidence: Record<string, unknown>;
  needs_external_runner?: boolean;
}

interface RequestBody {
  check_keys?: string[];
  dry_run?: boolean;
  triggered_by?: "cron" | "manual" | "api";
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function isAuthorized(req: Request): boolean {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const cronSecret = Deno.env.get("CRON_SECRET");
  const romCronBearer = Deno.env.get("ROM_CRON_BEARER");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (romCronBearer && bearer === romCronBearer) return true;
  if (cronSecret && bearer === cronSecret) return true;
  if (serviceKey && bearer === serviceKey) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Deep-equal helper for expected-result comparison
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!deepEqual(ao[ak[i]], bo[bk[i]])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dispatcher: SQL
//
// check_definition: {
//   sql: "select count(*) as n from clients where archived_at is null",
//   target?: "supabase.clients",     // free-text target identifier
//   mode?: "single_value"|"row_count"|"first_row"|"all_rows"  (default: "first_row")
// }
// expected: depends on mode:
//   single_value → { value: <scalar> }       (compares first column of first row)
//   row_count    → { eq?: n, gte?: n, lte?: n }
//   first_row    → { <col>: <val>, ... }      (deep-equal subset)
//   all_rows     → { rows: [...] }            (deep-equal whole result)
// If expected is null/empty, "passed" = query executed without throwing AND
// returned at least one row.
// ---------------------------------------------------------------------------
async function dispatchSql(
  check: IntegrityCheckRow,
  pg: PgClient,
): Promise<CheckResult> {
  const def = check.check_definition as {
    sql?: string;
    target?: string;
    mode?: "single_value" | "row_count" | "first_row" | "all_rows";
  };
  const target = def.target || `sql:${check.key}`;
  const sev = check.severity_on_fail as Severity;

  if (!def.sql || typeof def.sql !== "string") {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: "check_definition.sql missing",
        suggested_fix:
          "Add a non-empty sql string to integrity_checks.check_definition",
      },
    };
  }

  let rows: Record<string, unknown>[];
  try {
    const res = await pg.queryObject<Record<string, unknown>>(def.sql);
    rows = res.rows;
  } catch (e) {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: `sql execution failed: ${(e as Error).message}`,
        sql: def.sql,
        suggested_fix:
          "Verify SQL syntax + permissions for service role; this check returned an exception, not a value",
      },
    };
  }

  const mode = def.mode || "first_row";
  const expected = check.expected || {};

  if (mode === "row_count") {
    const n = rows.length;
    const exp = expected as { eq?: number; gte?: number; lte?: number };
    let passed = true;
    const failedConditions: string[] = [];
    if (typeof exp.eq === "number" && n !== exp.eq) {
      passed = false;
      failedConditions.push(`expected row count == ${exp.eq}, got ${n}`);
    }
    if (typeof exp.gte === "number" && n < exp.gte) {
      passed = false;
      failedConditions.push(`expected row count >= ${exp.gte}, got ${n}`);
    }
    if (typeof exp.lte === "number" && n > exp.lte) {
      passed = false;
      failedConditions.push(`expected row count <= ${exp.lte}, got ${n}`);
    }
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? { mode, row_count: n }
        : {
            mode,
            row_count: n,
            failed_conditions: failedConditions,
            sample_rows: rows.slice(0, 5),
            suggested_fix:
              "Investigate why the count drifted; check ingestion/cleanup jobs for this table",
          },
    };
  }

  if (mode === "single_value") {
    if (rows.length === 0) {
      return {
        check_key: check.key,
        passed: false,
        severity: sev,
        target,
        evidence: {
          error: "sql returned zero rows; expected a single scalar",
          sql: def.sql,
          suggested_fix:
            "Adjust the query to always return a row, or switch mode to row_count",
        },
      };
    }
    const first = rows[0];
    const firstKey = Object.keys(first)[0];
    const got = first[firstKey];
    const exp = (expected as { value?: unknown }).value;
    const passed = deepEqual(got, exp);
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? { mode, value: got }
        : {
            mode,
            expected: exp,
            got,
            suggested_fix: `Drive ${firstKey} back to ${JSON.stringify(exp)}; current value ${JSON.stringify(got)} violates the invariant`,
          },
    };
  }

  if (mode === "all_rows") {
    const exp = (expected as { rows?: unknown[] }).rows ?? [];
    const passed = deepEqual(rows, exp);
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? { mode, rows }
        : {
            mode,
            expected: exp,
            got: rows,
            suggested_fix:
              "Result set diverged from baseline; review additions/removals row-by-row",
          },
    };
  }

  // default: first_row subset match
  if (rows.length === 0) {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: "sql returned zero rows",
        sql: def.sql,
        suggested_fix:
          "Expected at least one row; either the source is empty or the predicate is wrong",
      },
    };
  }
  const first = rows[0];
  const expObj = expected as Record<string, unknown>;
  const mismatches: Record<string, { expected: unknown; got: unknown }> = {};
  for (const k of Object.keys(expObj)) {
    if (!deepEqual(first[k], expObj[k])) {
      mismatches[k] = { expected: expObj[k], got: first[k] };
    }
  }
  const passed = Object.keys(mismatches).length === 0;
  return {
    check_key: check.key,
    passed,
    severity: passed ? "warn" : sev,
    target,
    evidence: passed
      ? { mode, first_row: first }
      : {
          mode,
          first_row: first,
          mismatches,
          suggested_fix:
            "Reconcile the mismatched columns; see `mismatches` for exact expected vs got",
        },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher: api_fetch
//
// check_definition: {
//   url: "https://api.cloudflare.com/...",
//   method?: "GET"|"POST"|...,
//   headers?: { ... },                  // values support {{ENV_VAR}} substitution
//   body?: string|object,
//   target?: "cf.pages.austin-area-roofers",
//   timeout_ms?: number                 // default 15000
// }
// expected: {
//   status?: number|number[],           // default: any 2xx
//   json_contains?: { ... },             // deep-equal subset check on parsed JSON
//   body_includes?: string|string[]
// }
// ---------------------------------------------------------------------------
function substituteEnv(s: string): string {
  return s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    return Deno.env.get(name) ?? "";
  });
}

function subsetMatch(
  full: unknown,
  subset: Record<string, unknown>,
): { ok: boolean; mismatches: Record<string, { expected: unknown; got: unknown }> } {
  const mismatches: Record<string, { expected: unknown; got: unknown }> = {};
  if (!full || typeof full !== "object") {
    return { ok: false, mismatches: { _root: { expected: subset, got: full } } };
  }
  const fo = full as Record<string, unknown>;
  for (const k of Object.keys(subset)) {
    const e = subset[k];
    const g = fo[k];
    if (e && typeof e === "object" && !Array.isArray(e)) {
      const sub = subsetMatch(g, e as Record<string, unknown>);
      if (!sub.ok) {
        for (const sk of Object.keys(sub.mismatches)) {
          mismatches[`${k}.${sk}`] = sub.mismatches[sk];
        }
      }
    } else if (!deepEqual(g, e)) {
      mismatches[k] = { expected: e, got: g };
    }
  }
  return { ok: Object.keys(mismatches).length === 0, mismatches };
}

async function dispatchApiFetch(
  check: IntegrityCheckRow,
  pg: PgClient | null,
): Promise<CheckResult> {
  const def = check.check_definition as {
    url?: string;
    url_template?: string;
    api?: { url?: string; method?: string; headers?: Record<string, string>; headers_from_env?: string[] };
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    target?: string;
    timeout_ms?: number;
    iterate_over?: string;
    expected_status?: number;
  };
  const target = def.target || `api:${check.key}`;
  const sev = check.severity_on_fail as Severity;

  // Resolve effective URL template: prefer url_template, then api.url, then url.
  const effectiveUrlTemplate = def.url_template
    || (def.api && def.api.url)
    || def.url;

  if (!effectiveUrlTemplate) {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: "check_definition.url / url_template / api.url missing",
        suggested_fix:
          "Add a url, url_template, or api.url string to integrity_checks.check_definition",
      },
    };
  }

  // Merge headers: top-level headers + api.headers + headers_from_env
  const baseHeaders: Record<string, string> = { ...(def.headers || {}), ...((def.api && def.api.headers) || {}) };
  if (def.api && Array.isArray(def.api.headers_from_env)) {
    for (const envName of def.api.headers_from_env) {
      if (envName === "CLOUDFLARE_API_TOKEN" && !baseHeaders["Authorization"]) {
        const tok = Deno.env.get("CLOUDFLARE_API_TOKEN") || "";
        if (tok) baseHeaders["Authorization"] = `Bearer ${tok}`;
      }
    }
  }
  const effectiveMethod = def.method || (def.api && def.api.method) || "GET";

  // Substitute $ENV refs in header values (e.g. "Bearer $CF_API_TOKEN" or "Bearer $CLOUDFLARE_API_TOKEN")
  const resolveHeaderValue = (v: string): string => {
    let out = substituteEnv(v);
    out = out.replace(/\$([A-Z0-9_]+)/g, (_m, name) => {
      if (name === "CF_API_TOKEN") return Deno.env.get("CLOUDFLARE_API_TOKEN") || Deno.env.get("CF_API_TOKEN") || "";
      return Deno.env.get(name) ?? "";
    });
    return out;
  };

  // ----- Iteration path: url_template + iterate_over SQL -----
  const iter = def.iterate_over;
  const looksLikeSql = typeof iter === "string" && /^\s*select\s/i.test(iter);
  if (looksLikeSql && pg) {
    let rows: Record<string, unknown>[] = [];
    try {
      const res = await pg.queryObject<Record<string, unknown>>(iter);
      rows = res.rows;
    } catch (e) {
      return {
        check_key: check.key,
        passed: false,
        severity: sev,
        target,
        evidence: {
          error: `iterate_over sql failed: ${(e as Error).message}`,
          sql: iter,
          suggested_fix: "Fix the iterate_over SQL so it returns at least one substitution row",
        },
      };
    }

    // cf_* hardening: for any check_key prefixed cf_, re-resolve each row's
    // client_slug to honour:
    //   - website_management_mode filter (only custom_rom_stack clients have CF projects)
    //   - client_json.cf_project_name override (manual pin)
    //   - slug sanitization (drop !, ., apostrophes, etc — CF only accepts ^[a-z0-9-]+$)
    // Rows that don't resolve to a valid CF slug get filtered out (skipped, not failed).
    const isCfCheck = /^cf_/i.test(check.key);
    let skippedRows: Array<{ client_id?: unknown; reason: string }> = [];
    if (isCfCheck) {
      const ids = rows
        .map((r) => r["id"] ?? r["client_id"])
        .filter((v) => typeof v === "string" || typeof v === "number");
      if (ids.length > 0) {
        try {
          const lookup = await pg.queryObject<{
            id: string;
            business_name: string | null;
            client_json: Record<string, unknown> | null;
          }>(`select id::text, business_name, client_json from clients where id::text = any($1::text[])`, [ids.map(String)]);
          const byId = new Map<string, { business_name: string | null; client_json: Record<string, unknown> | null }>();
          for (const lr of lookup.rows) byId.set(lr.id, { business_name: lr.business_name, client_json: lr.client_json });
          const filtered: Record<string, unknown>[] = [];
          for (const r of rows) {
            const rid = String(r["id"] ?? r["client_id"] ?? "");
            const found = byId.get(rid);
            if (!found) {
              skippedRows.push({ client_id: rid, reason: "client row not found" });
              continue;
            }
            const cj = (found.client_json || {}) as Record<string, unknown>;
            const mode = String((cj as { website_management_mode?: unknown }).website_management_mode || "");
            if (mode && mode !== "custom_rom_stack") {
              skippedRows.push({ client_id: rid, reason: `website_management_mode=${mode}` });
              continue;
            }
            // Resolve slug: client_json.cf_project_name override → existing client_slug → from business_name
            const override = String((cj as { cf_project_name?: unknown }).cf_project_name || "").trim();
            let slug = override || String(r["client_slug"] || "") || String(found.business_name || "").toLowerCase().replace(/\s+/g, "-");
            // Sanitize to ^[a-z0-9-]+$
            slug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
            if (!slug) {
              skippedRows.push({ client_id: rid, reason: "slug empty after sanitization" });
              continue;
            }
            filtered.push({ ...r, client_slug: slug, slug });
          }
          rows = filtered;
        } catch (e) {
          console.warn(`cf_* hardening lookup failed: ${(e as Error).message}; falling back to raw rows`);
        }
      }
    }

    if (rows.length === 0) {
      return {
        check_key: check.key,
        passed: true,
        severity: "warn",
        target,
        evidence: {
          iterated: 0,
          note: isCfCheck ? "no eligible custom_rom_stack clients with valid CF slug" : "iterate_over returned 0 rows; nothing to check",
          skipped: skippedRows.slice(0, 20),
        },
      };
    }

    const perItem: Array<{ subs: Record<string, unknown>; url: string; status: number | null; ok: boolean; failures: string[]; body_sample?: string; skipped?: boolean }> = [];
    const expStatus = def.expected_status;
    for (const row of rows) {
      let urlOut = effectiveUrlTemplate;
      for (const [k, v] of Object.entries(row)) {
        urlOut = urlOut.replaceAll(`{${k}}`, String(v ?? ""));
      }
      urlOut = substituteEnv(urlOut);

      // Skip CF /cdn-cgi/* paths — these are internal CF endpoints, never our targets.
      if (/\/cdn-cgi\//.test(urlOut)) {
        perItem.push({ subs: row, url: urlOut, status: null, ok: true, failures: [], skipped: true });
        continue;
      }
      const headersOut: Record<string, string> = {};
      for (const [k, v] of Object.entries(baseHeaders)) headersOut[k] = resolveHeaderValue(String(v));

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), def.timeout_ms || 15000);
      let status: number | null = null;
      let text = "";
      const failures: string[] = [];
      try {
        const res = await fetch(urlOut, { method: effectiveMethod, headers: headersOut, signal: ac.signal });
        status = res.status;
        text = await res.text();
      } catch (e) {
        failures.push(`fetch failed: ${(e as Error).message}`);
      }
      clearTimeout(t);
      const ok2xx = status !== null && status >= 200 && status < 300;
      const statusOk = expStatus ? status === expStatus : ok2xx;
      if (!statusOk) failures.push(`status ${status} (expected ${expStatus ?? "2xx"})`);
      perItem.push({ subs: row, url: urlOut, status, ok: failures.length === 0, failures, body_sample: text.slice(0, 200) });
    }

    const failedItems = perItem.filter((i) => !i.ok && !i.skipped);
    const skippedCount = perItem.filter((i) => i.skipped).length + skippedRows.length;
    const passed = failedItems.length === 0;
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? {
            mode: "iterate_url_template",
            iterated: perItem.length,
            skipped: skippedCount,
            skipped_sample: skippedRows.slice(0, 10),
            sample: perItem.filter((i) => !i.skipped).slice(0, 3).map((i) => ({ url: i.url, status: i.status })),
          }
        : {
            mode: "iterate_url_template",
            iterated: perItem.length,
            skipped: skippedCount,
            failed: failedItems.length,
            failures: failedItems.slice(0, 20).map((i) => ({ url: i.url, status: i.status, why: i.failures })),
            suggested_fix:
              "Investigate failing iterations individually; each row in iterate_over got its own fetch attempt",
          },
    };
  }

  // ----- Single-URL path (legacy) -----
  const url = substituteEnv(effectiveUrlTemplate);

  // Skip CF /cdn-cgi/* paths — internal CF endpoints, not valid check targets.
  if (/\/cdn-cgi\//.test(url)) {
    return {
      check_key: check.key,
      passed: true,
      severity: "warn",
      target,
      evidence: { skipped: true, reason: "url is /cdn-cgi/* (Cloudflare internal)", url },
    };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseHeaders)) {
    headers[k] = resolveHeaderValue(String(v));
  }
  const body =
    typeof def.body === "string"
      ? substituteEnv(def.body)
      : def.body
        ? JSON.stringify(def.body)
        : undefined;

  const timeoutMs = def.timeout_ms || 15000;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: effectiveMethod,
      headers,
      body,
      signal: ac.signal,
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(t);
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: `fetch failed: ${(e as Error).message}`,
        url,
        suggested_fix:
          "Verify network reachability + auth headers; check timeout_ms if request is slow",
      },
    };
  }
  clearTimeout(t);

  const expected = check.expected || {};
  const expStatus = (expected as { status?: number | number[] }).status;
  const expJsonContains = (expected as { json_contains?: Record<string, unknown> }).json_contains;
  const expBodyIncludes = (expected as { body_includes?: string | string[] }).body_includes;

  // status check
  let statusOk = false;
  if (expStatus === undefined) {
    statusOk = res.status >= 200 && res.status < 300;
  } else if (Array.isArray(expStatus)) {
    statusOk = expStatus.includes(res.status);
  } else {
    statusOk = res.status === expStatus;
  }

  const failures: string[] = [];
  if (!statusOk) {
    failures.push(
      `status ${res.status} (expected ${expStatus === undefined ? "2xx" : JSON.stringify(expStatus)})`,
    );
  }

  let parsedJson: unknown = undefined;
  if (expJsonContains) {
    try {
      parsedJson = JSON.parse(text);
    } catch (_) {
      failures.push("response body not valid JSON; json_contains check skipped");
    }
    if (parsedJson !== undefined) {
      const sub = subsetMatch(parsedJson, expJsonContains);
      if (!sub.ok) {
        failures.push(`json_contains mismatches: ${JSON.stringify(sub.mismatches)}`);
      }
    }
  }

  if (expBodyIncludes) {
    const needles = Array.isArray(expBodyIncludes)
      ? expBodyIncludes
      : [expBodyIncludes];
    for (const n of needles) {
      if (!text.includes(n)) failures.push(`body missing substring: ${n}`);
    }
  }

  const passed = failures.length === 0;
  return {
    check_key: check.key,
    passed,
    severity: passed ? "warn" : sev,
    target,
    evidence: passed
      ? {
          status: res.status,
          url,
          body_sample: text.slice(0, 500),
        }
      : {
          status: res.status,
          url,
          failed_conditions: failures,
          body_sample: text.slice(0, 1000),
          suggested_fix:
            "Inspect the target endpoint; the response no longer matches the documented expected shape",
        },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher: cross_compare
//
// check_definition: {
//   sources: [
//     { name: "supabase_clients", kind: "sql", sql: "select slug from clients where archived_at is null" },
//     { name: "cf_pages",         kind: "api_fetch", url: "...", headers: {...}, json_path: "result[*].name" }
//   ],
//   compare: {
//     mode: "equal_sets" | "subset" | "field_equality",
//     extract: { <source_name>: <jq-ish path or column name> }
//   },
//   target?: "cf↔supabase.clients"
// }
// ---------------------------------------------------------------------------

// Minimal path extractor: supports "a.b.c" and "a[*].b" for arrays.
function extractPath(obj: unknown, path: string): unknown[] {
  if (!path) return [obj];
  const parts = path.split(".");
  let current: unknown[] = [obj];
  for (const part of parts) {
    const m = part.match(/^([^\[]+)(\[\*\])?$/);
    if (!m) return [];
    const key = m[1];
    const isArray = !!m[2];
    const next: unknown[] = [];
    for (const c of current) {
      if (c && typeof c === "object" && key in (c as Record<string, unknown>)) {
        const v = (c as Record<string, unknown>)[key];
        if (isArray && Array.isArray(v)) {
          for (const item of v) next.push(item);
        } else {
          next.push(v);
        }
      }
    }
    current = next;
  }
  return current;
}

async function fetchSourceValues(
  source: {
    name: string;
    kind: string;
    sql?: string;
    column?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    json_path?: string;
  },
  pg: PgClient,
): Promise<{ ok: true; values: unknown[] } | { ok: false; error: string }> {
  if (source.kind === "sql") {
    if (!source.sql) return { ok: false, error: "source.sql missing" };
    try {
      const res = await pg.queryObject<Record<string, unknown>>(source.sql);
      const col = source.column;
      const values = res.rows.map((r) => {
        if (col) return r[col];
        const k = Object.keys(r)[0];
        return r[k];
      });
      return { ok: true, values };
    } catch (e) {
      return { ok: false, error: `sql failed: ${(e as Error).message}` };
    }
  }
  if (source.kind === "api_fetch") {
    if (!source.url) return { ok: false, error: "source.url missing" };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(source.headers || {})) {
      headers[k] = substituteEnv(String(v));
    }
    try {
      const res = await fetch(substituteEnv(source.url), {
        method: source.method || "GET",
        headers,
        body:
          typeof source.body === "string"
            ? substituteEnv(source.body)
            : source.body
              ? JSON.stringify(source.body)
              : undefined,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        return { ok: false, error: "response not JSON" };
      }
      const values = extractPath(parsed, source.json_path || "");
      return { ok: true, values };
    } catch (e) {
      return { ok: false, error: `fetch failed: ${(e as Error).message}` };
    }
  }
  return { ok: false, error: `unsupported source.kind: ${source.kind}` };
}

async function dispatchCrossCompare(
  check: IntegrityCheckRow,
  pg: PgClient,
): Promise<CheckResult> {
  const def = check.check_definition as {
    sources?: Array<{
      name: string;
      kind: string;
      sql?: string;
      column?: string;
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      json_path?: string;
    }>;
    compare?: { mode?: "equal_sets" | "subset"; primary?: string; secondary?: string };
    target?: string;
  };
  const target = def.target || `cross:${check.key}`;
  const sev = check.severity_on_fail as Severity;

  if (!def.sources || def.sources.length < 2) {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: "cross_compare needs at least 2 sources",
        suggested_fix:
          "Add a second source to check_definition.sources before re-enabling",
      },
    };
  }

  const fetched: Record<string, unknown[]> = {};
  const errors: Record<string, string> = {};
  for (const s of def.sources) {
    const r = await fetchSourceValues(s, pg);
    if (r.ok) fetched[s.name] = r.values;
    else errors[s.name] = r.error;
  }

  if (Object.keys(errors).length > 0) {
    return {
      check_key: check.key,
      passed: false,
      severity: sev,
      target,
      evidence: {
        error: "one or more sources failed",
        source_errors: errors,
        suggested_fix:
          "Fix the failing source before treating the cross-compare result as meaningful",
      },
    };
  }

  const mode = def.compare?.mode || "equal_sets";
  const names = Object.keys(fetched);
  const primary = def.compare?.primary || names[0];
  const secondary = def.compare?.secondary || names[1];

  const norm = (v: unknown) =>
    typeof v === "string" ? v.toLowerCase().trim() : v;
  const setA = new Set((fetched[primary] || []).map(norm));
  const setB = new Set((fetched[secondary] || []).map(norm));

  if (mode === "equal_sets") {
    const onlyInA = [...setA].filter((x) => !setB.has(x));
    const onlyInB = [...setB].filter((x) => !setA.has(x));
    const passed = onlyInA.length === 0 && onlyInB.length === 0;
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? { mode, count: setA.size }
        : {
            mode,
            only_in_primary: { source: primary, values: onlyInA.slice(0, 50) },
            only_in_secondary: {
              source: secondary,
              values: onlyInB.slice(0, 50),
            },
            primary_total: setA.size,
            secondary_total: setB.size,
            suggested_fix: `Reconcile ${primary} vs ${secondary}: add missing entries to whichever side is incomplete; if intentional, exclude from this check`,
          },
    };
  }

  if (mode === "subset") {
    // primary must be a subset of secondary
    const missing = [...setA].filter((x) => !setB.has(x));
    const passed = missing.length === 0;
    return {
      check_key: check.key,
      passed,
      severity: passed ? "warn" : sev,
      target,
      evidence: passed
        ? { mode, primary_count: setA.size, secondary_count: setB.size }
        : {
            mode,
            primary: primary,
            secondary: secondary,
            missing_in_secondary: missing.slice(0, 50),
            suggested_fix: `Every entry in ${primary} should exist in ${secondary}; missing ${missing.length} entries`,
          },
    };
  }

  return {
    check_key: check.key,
    passed: false,
    severity: sev,
    target,
    evidence: {
      error: `unsupported compare.mode: ${mode}`,
      suggested_fix: "Use 'equal_sets' or 'subset'",
    },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher: shell (stub — can't run in an edge function)
//
// Marked as inconclusive. The needs_external_runner flag tells the
// local runner (launchd/GH Action) to pick this up.
// ---------------------------------------------------------------------------
function dispatchShellStub(check: IntegrityCheckRow): CheckResult {
  const def = check.check_definition as { shell?: string; target?: string };
  const target = def.target || `shell:${check.key}`;
  return {
    check_key: check.key,
    passed: false,
    severity: "inconclusive",
    target,
    needs_external_runner: true,
    evidence: {
      reason: "shell checks cannot execute inside a Deno edge function",
      shell: def.shell || null,
      suggested_fix:
        "Run via the daily local runner (launchd on Daniel's Mac OR a GH Action) and POST results back into integrity_runs / integrity_findings. See integrity-runner README.",
    },
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  const pre = handleCors(req);
  if (pre) return pre;

  const corsHeaders = {
    ...getCorsHeaders(req),
    "Content-Type": "application/json",
  };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  let body: RequestBody = {};
  try {
    const raw = await req.text();
    body = raw ? (JSON.parse(raw) as RequestBody) : {};
  } catch (_) {
    body = {};
  }

  const dryRun = !!body.dry_run;
  const triggeredBy = body.triggered_by || "api";
  const filterKeys = body.check_keys && body.check_keys.length > 0
    ? new Set(body.check_keys)
    : null;

  const startedAt = Date.now();

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Load check catalog
  const { data: checks, error: checksErr } = await supa
    .from("integrity_checks")
    .select(
      "id, key, title, category, severity_on_fail, check_kind, check_definition, expected, enabled",
    )
    .eq("enabled", true);

  if (checksErr) {
    return new Response(
      JSON.stringify({
        error: `failed to load integrity_checks: ${checksErr.message}`,
      }),
      { status: 500, headers: corsHeaders },
    );
  }

  const all = (checks || []) as IntegrityCheckRow[];
  const queue = filterKeys ? all.filter((c) => filterKeys.has(c.key)) : all;

  // pg client for sql / cross_compare
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  let pg: PgClient | null = null;
  const needsPg = queue.some(
    (c) =>
      c.check_kind === "sql" ||
      c.check_kind === "cross_compare" ||
      (c.check_kind === "api_fetch" &&
        typeof (c.check_definition as { iterate_over?: unknown }).iterate_over === "string" &&
        /^\s*select\s/i.test((c.check_definition as { iterate_over: string }).iterate_over)),
  );
  if (needsPg) {
    if (!dbUrl) {
      return new Response(
        JSON.stringify({
          error: "SUPABASE_DB_URL not set; required for sql + cross_compare checks",
        }),
        { status: 500, headers: corsHeaders },
      );
    }
    pg = new PgClient(dbUrl);
    try {
      await pg.connect();
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: `pg connect failed: ${(e as Error).message}`,
        }),
        { status: 500, headers: corsHeaders },
      );
    }
  }

  const results: CheckResult[] = [];
  const needsExternalRunner: string[] = [];

  for (const c of queue) {
    let r: CheckResult;
    try {
      if (c.check_kind === "sql") {
        r = await dispatchSql(c, pg!);
      } else if (c.check_kind === "api_fetch") {
        r = await dispatchApiFetch(c, pg);
      } else if (c.check_kind === "cross_compare") {
        r = await dispatchCrossCompare(c, pg!);
      } else if (c.check_kind === "shell") {
        r = dispatchShellStub(c);
      } else {
        r = {
          check_key: c.key,
          passed: false,
          severity: "inconclusive",
          target: c.key,
          evidence: {
            error: `unknown check_kind: ${c.check_kind}`,
            suggested_fix:
              "Set check_kind to one of: sql, shell, api_fetch, cross_compare",
          },
        };
      }
    } catch (e) {
      r = {
        check_key: c.key,
        passed: false,
        severity: c.severity_on_fail as Severity,
        target: c.key,
        evidence: {
          error: `dispatcher threw: ${(e as Error).message}`,
          suggested_fix:
            "Inspect server logs; this is an integrity-runner bug, not a target-system bug",
        },
      };
    }
    if (r.needs_external_runner) needsExternalRunner.push(c.key);
    results.push(r);
  }

  // tally
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const critical = results.filter((r) => !r.passed && r.severity === "critical").length;
  const fail = results.filter((r) => !r.passed && r.severity === "fail").length;
  const warn = results.filter((r) => !r.passed && r.severity === "warn").length;
  const inconclusive = results.filter((r) => r.severity === "inconclusive").length;
  const durationMs = Date.now() - startedAt;

  let runId: string | null = null;
  let newIssues = 0;
  let resolvedIssues = 0;
  const writeErrors: string[] = [];

  if (!dryRun) {
    // insert integrity_runs
    const { data: runRow, error: runErr } = await supa
      .from("integrity_runs")
      .insert({
        triggered_by: triggeredBy,
        total_checks: total,
        passed,
        failed: critical + fail,
        warned: warn,
        critical,
        inconclusive,
        duration_ms: durationMs,
        summary: {
          needs_external_runner: needsExternalRunner,
          filter_keys: filterKeys ? Array.from(filterKeys) : null,
        },
      })
      .select("id")
      .single();

    if (runErr) {
      writeErrors.push(`integrity_runs insert failed: ${runErr.message}`);
    } else {
      runId = runRow.id as string;
    }

    // For each result, manage findings lifecycle
    for (const r of results) {
      if (!r.passed) {
        // find an open finding for the same check_key + target
        const { data: existing, error: exErr } = await supa
          .from("integrity_findings")
          .select("id")
          .eq("check_key", r.check_key)
          .eq("target", r.target)
          .is("resolved_at", null)
          .limit(1);

        if (exErr) {
          writeErrors.push(
            `lookup open finding failed (${r.check_key}): ${exErr.message}`,
          );
          continue;
        }

        if (!existing || existing.length === 0) {
          // brand new issue
          const { error: insErr } = await supa
            .from("integrity_findings")
            .insert({
              run_id: runId,
              check_key: r.check_key,
              severity: r.severity,
              target: r.target,
              evidence: r.evidence,
            });
          if (insErr) {
            writeErrors.push(
              `insert finding failed (${r.check_key}): ${insErr.message}`,
            );
          } else {
            newIssues += 1;
          }
        }
        // else: keep the existing open finding; do not duplicate
      } else {
        // passed → resolve any open finding for this check_key + target
        const { data: openOnes, error: lookErr } = await supa
          .from("integrity_findings")
          .select("id")
          .eq("check_key", r.check_key)
          .eq("target", r.target)
          .is("resolved_at", null);
        if (lookErr) {
          writeErrors.push(
            `lookup resolved finding failed (${r.check_key}): ${lookErr.message}`,
          );
          continue;
        }
        if (openOnes && openOnes.length > 0) {
          const { error: updErr } = await supa
            .from("integrity_findings")
            .update({
              resolved_at: new Date().toISOString(),
              resolution_note: `auto-resolved by run ${runId || "(dry)"} — check passed`,
            })
            .in(
              "id",
              openOnes.map((o) => o.id),
            );
          if (updErr) {
            writeErrors.push(
              `resolve finding failed (${r.check_key}): ${updErr.message}`,
            );
          } else {
            resolvedIssues += openOnes.length;
          }
        }
      }
    }
  }

  if (pg) {
    try {
      await pg.end();
    } catch (_) { /* ignore */ }
  }

  // Post digest to #rom-internal-ops (skip on dry_run)
  if (!dryRun) {
    const when = new Date().toISOString();
    const text =
      `:mag: System integrity sweep · ${when}\n` +
      `• ✅ ${passed}/${total} checks passing\n` +
      `• 🚨 ${critical} critical\n` +
      `• ❌ ${fail} fail\n` +
      `• ⚠️ ${warn} warn\n` +
      `• ➖ ${inconclusive} inconclusive (needs external runner)\n` +
      `New issues: ${newIssues}\n` +
      `Resolved: ${resolvedIssues}\n` +
      `Dashboard: hq.rankonmaps.io/system/integrity`;
    try {
      // Route by sweep result: critical findings → ops_alerts immediate, else queue to ops_qc digest.
      if (critical > 0) {
        await postSlackBySeverity("critical", text, {
          group: "integrity-critical",
          source_fn: "integrity-runner",
          payload: { critical, fail, warn, run_id: runId },
        });
      } else {
        await postSlackBySeverity("warn", text, {
          group: "integrity-sweep",
          source_fn: "integrity-runner",
          payload: { critical, fail, warn, passed, total, run_id: runId },
        });
      }
    } catch (e) {
      writeErrors.push(`slack post failed: ${(e as Error).message}`);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      run_id: runId,
      dry_run: dryRun,
      triggered_by: triggeredBy,
      duration_ms: durationMs,
      totals: {
        total,
        passed,
        failed: critical + fail,
        critical,
        warn,
        inconclusive,
      },
      new_issues: newIssues,
      resolved_issues: resolvedIssues,
      needs_external_runner: needsExternalRunner,
      write_errors: writeErrors,
      results: results.map((r) => ({
        check_key: r.check_key,
        passed: r.passed,
        severity: r.severity,
        target: r.target,
        evidence: r.evidence,
      })),
    }),
    { status: 200, headers: corsHeaders },
  );
});
