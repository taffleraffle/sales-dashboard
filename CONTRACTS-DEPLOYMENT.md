# Contracts Feature — Deployment Steps

Generated 2026-05-24. Phase 1+2+3 of the contracts feature (schema, pages,
nav, AI judge Edge Function, Slack escalation, mark-as-applied UI).
No PandaDoc API integration — closers manage PandaDoc themselves and use
the dashboard for amendment requests + the AI judge's verdict.

## 1. Run the migration

Sentinel is blocked for ~1 month, so run directly in Supabase Studio:

1. Open https://supabase.com/dashboard/project/kjfaqhmllagbxjdxlopm/sql/new
2. Paste the contents of [migrations/015_contracts.sql](migrations/015_contracts.sql)
3. Hit **Run**. Should complete without errors.
4. Verify with:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND table_name LIKE 'contract%';
   ```
   Should return: `contracts`, `contract_amendments`, `contract_policy`.

The migration is safe to re-run — uses `CREATE TABLE IF NOT EXISTS` and
`DROP POLICY IF EXISTS` everywhere.

## 2. Deploy the Edge Function

From the `sales-dashboard/` directory:

```bash
supabase functions deploy contract-judge-amendment --project-ref kjfaqhmllagbxjdxlopm
```

If you haven't authenticated:
```bash
supabase login
supabase link --project-ref kjfaqhmllagbxjdxlopm
```

## 3. Secrets

`ANTHROPIC_API_KEY` is already set (used by `sales-chat`). The judge function
will pick it up automatically.

**Optional but recommended — Slack escalation:**
```bash
supabase secrets set SLACK_CONTRACTS_WEBHOOK_URL=https://hooks.slack.com/services/... --project-ref kjfaqhmllagbxjdxlopm
```

If not set, the judge silently skips Slack notifications — you'll only see
escalations in `/sales/contracts/pending`.

**Optional — explicit dashboard URL (used in Slack links):**
```bash
supabase secrets set DASHBOARD_BASE_URL=https://sales-dashboard-ftct.onrender.com --project-ref kjfaqhmllagbxjdxlopm
```
Defaults to the prod URL if unset.

## 4. Seed the policy

1. Open `/sales/contracts/policy` in the dashboard (admin-only)
2. Paste the body of [CONTRACT-POLICY-SEED.md](CONTRACT-POLICY-SEED.md) into
   the editor (skip the top heading and front-matter)
3. Save. The judge won't run until there's an active non-empty policy.

## 5. Smoke test

1. Go to `/sales/contracts/new`, create a stub contract:
   - Client: `Test Client`
   - Fee: `997`
   - Period: `14`
2. Open the contract, scroll to "Request an amendment"
3. Submit a clear ALLOW request, e.g.:
   - Clause: `Clause 7.2(f)`
   - What client wants: `Remove the $7 dishonour fee. Their bank doesn't charge for one-off DD failures.`
4. Watch the verdict come back in ~5-15 seconds. Should show:
   - **Auto-approved** badge (green)
   - Judge reasoning citing the dishonour fee waiver rule
   - A proposed redline
   - **Mark as applied in PandaDoc** button
5. Submit a clear BLOCK request:
   - Clause: `Clause 19.1`
   - What client wants: `Move governing law from New Zealand to California.`
6. Should come back **Blocked** with reasoning citing the jurisdiction rule.
   Slack DM fires (if webhook is set).
7. Submit a GREY request:
   - Clause: `Clause 7.2`
   - What client wants: `Switch from Direct Debit to manual ACH invoice.`
8. Should come back **Pending Ben**. Visible in `/sales/contracts/pending`
   for admin approval. Slack DM fires.
9. As admin, open `/sales/contracts/pending`, approve the grey one — it
   should move to `approved` and the closer can now mark it as applied.

## 6. Watch the logs

If the judge misbehaves:
```
supabase functions logs contract-judge-amendment --project-ref kjfaqhmllagbxjdxlopm
```

Common failure modes:
- **412 "no active policy doc"** → step 4 not done
- **502 "Claude API error"** → check ANTHROPIC_API_KEY secret value
- **502 "Claude did not call submit_verdict"** → very rare; usually a model
  routing issue. Re-submit the amendment.

## What ships when

| Phase | Done | Notes |
|---|---|---|
| 1. Schema + pages + nav + CSS | yes | This commit |
| 2. AI judge Edge Function | yes | Runs on every amendment submit |
| 3. Slack escalation | yes (optional) | No-op if webhook unset |
| 4. Mark-as-applied UI | yes | Closer-driven; tracks audit trail |
| 5. PandaDoc API integration | **skipped** | Closers manage PandaDoc manually; revisit only if it becomes the bottleneck |
