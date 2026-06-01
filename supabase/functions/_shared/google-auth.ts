// Multi-account Google OAuth helper.
// Loads OAuth accounts from the google_oauth_accounts table (primary first),
// refreshes access tokens on demand, caches per-email for the request lifetime.
// Supports fallback chain: try preferred account first, fall back to others on 403/404.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

interface OAuthAccount {
  email: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
  is_primary: boolean;
}

const tokenCache = new Map<string, { access_token: string; expires_at: number }>();

function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export async function listOAuthAccounts(): Promise<OAuthAccount[]> {
  const supa = adminClient();
  const { data, error } = await supa
    .from("google_oauth_accounts")
    .select("email, refresh_token, client_id, client_secret, is_primary")
    .is("last_error", null)
    .order("is_primary", { ascending: false })
    .order("last_validated_at", { ascending: false, nullsFirst: false });
  if (error) throw new Error(`oauth accounts: ${error.message}`);
  // Backwards compat: if table is empty, fall back to env-var single account
  if (!data || data.length === 0) {
    const refresh = Deno.env.get("GOOGLE_REFRESH_TOKEN");
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (refresh && clientId && clientSecret) {
      return [{ email: "default", refresh_token: refresh, client_id: clientId, client_secret: clientSecret, is_primary: true }];
    }
    return [];
  }
  return data;
}

async function refreshAccessToken(account: OAuthAccount): Promise<string> {
  const cached = tokenCache.get(account.email);
  if (cached && cached.expires_at > Date.now() + 30_000) return cached.access_token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: account.client_id,
      client_secret: account.client_secret,
      refresh_token: account.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token refresh failed for ${account.email}: ${res.status} ${text}`);
  }
  const data = await res.json();
  const token = data.access_token as string;
  tokenCache.set(account.email, { access_token: token, expires_at: Date.now() + (data.expires_in * 1000) });
  return token;
}

// Legacy single-account API (backwards compat with existing callers)
export async function getGoogleAccessToken(): Promise<string> {
  const accounts = await listOAuthAccounts();
  if (accounts.length === 0) throw new Error("no Google OAuth accounts configured");
  return refreshAccessToken(accounts[0]);
}

// Multi-account API — returns access token + email for a specific account
export async function getAccessTokenForEmail(email: string): Promise<{ token: string; account: OAuthAccount } | null> {
  const accounts = await listOAuthAccounts();
  const match = accounts.find((a) => a.email === email);
  if (!match) return null;
  return { token: await refreshAccessToken(match), account: match };
}

// Try-each helper — invokes the callback once per available account, returns the first non-null result
export async function withEachOAuthAccount<T>(
  fn: (token: string, account: OAuthAccount) => Promise<T | null>,
  preferredEmail?: string,
): Promise<{ result: T; account: OAuthAccount } | null> {
  const accounts = await listOAuthAccounts();
  if (accounts.length === 0) return null;

  // Reorder: preferred first if specified
  const ordered = preferredEmail
    ? [...accounts.filter((a) => a.email === preferredEmail), ...accounts.filter((a) => a.email !== preferredEmail)]
    : accounts;

  for (const account of ordered) {
    try {
      const token = await refreshAccessToken(account);
      const result = await fn(token, account);
      if (result != null) return { result, account };
    } catch (e) {
      console.warn(`account ${account.email} failed: ${(e as Error).message}`);
    }
  }
  return null;
}

export async function persistAccountSuccess(supa: SupabaseClient, accountEmail: string, clientId?: string): Promise<void> {
  await supa.from("google_oauth_accounts").update({ last_validated_at: new Date().toISOString(), last_error: null }).eq("email", accountEmail);
  // If a client_id is given, persist which OAuth account works for this client
  if (clientId) {
    const { data: client } = await supa.from("clients").select("client_json").eq("id", clientId).maybeSingle();
    const cj = ((client?.client_json as Record<string, unknown>) || {});
    cj.gbp_oauth_account = accountEmail;
    await supa.from("clients").update({ client_json: cj }).eq("id", clientId);
  }
}
