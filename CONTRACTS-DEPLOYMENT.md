# Contracts Feature — Deployment Steps

Generated 2026-05-24, updated 2026-05-25 with the **Downsell Coach** addition
(migration 021 + `contract-downsell-coach` Edge Function + Downsell tab on
the policy editor + DownsellCoach panel on every ContractDetail page).
No PandaDoc API integration — closers manage PandaDoc themselves and use
the dashboard for amendment requests, the AI judge's verdict, and the
downsell coach.

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
| 6. Downsell coach (migration 021 + Edge fn + UI) | yes | 2026-05-25 |
| 7. Policy RLS lockdown (migration 022) | yes | 2026-05-25 — closers can no longer read policy via API |

---

## Downsell Coach — additional deploy steps (2026-05-25)

The downsell coach is a parallel conversational system on every ContractDetail
page. It uses its own policy doc (kind='downsell'), its own tables
(`contract_downsell_threads`, `contract_downsell_messages`), and its own
Edge function (`contract-downsell-coach`). The amendment judge is unchanged
except it now scopes its policy fetch by `kind='amendment'` — if you
deployed migration 021 but did NOT redeploy `contract-judge-amendment`,
the judge will keep working (it falls back to the first active row),
but you should redeploy both to be safe.

### A. Apply migrations 021 + 022

Run both in Supabase Studio SQL Editor:

1. [migrations/021_contract_downsell.sql](migrations/021_contract_downsell.sql)
   — adds the downsell threads/messages tables + `kind` column on
   `contract_policy`. Safe to re-run.
2. [migrations/022_contract_policy_admin_only_read.sql](migrations/022_contract_policy_admin_only_read.sql)
   — tightens `contract_policy` SELECT from "any authenticated user" to
   "admin only." Required because the downsell policy will contain
   internal unit economics (per-line COGS, margin formulas, finance
   structure) that closers must not be able to read via the API. The
   Edge functions use service_role and bypass RLS, so they keep
   working. The admin Policy editor page keeps working because admin
   passes `contracts_is_admin()`. Safe to re-run.

Verify with:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name LIKE 'contract_downsell%';
-- expect: contract_downsell_threads, contract_downsell_messages

SELECT kind, count(*), max(created_at)
FROM contract_policy GROUP BY kind;
-- expect: amendment + downsell rows, both with a recent created_at

-- Verify the RLS lockdown landed
SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr
FROM pg_policy
WHERE polrelid = 'public.contract_policy'::regclass
  AND polcmd = 'r';
-- expect using_expr = contracts_is_admin() (not 'true')
```

### B. Deploy both Edge Functions

```bash
supabase functions deploy contract-downsell-coach --project-ref kjfaqhmllagbxjdxlopm
supabase functions deploy contract-judge-amendment --project-ref kjfaqhmllagbxjdxlopm
```

The judge redeploy picks up the new `.eq('kind', 'amendment')` filter on
the policy fetch. Without it the judge still works but reads the most
recent active policy of any kind — i.e. if you save the downsell policy
last, the judge would start quoting downsell rules. Redeploy is cheap;
do it.

### C. Seed the downsell policy

1. Open `/sales/contracts/policy`
2. Switch to the **Downsell** tab (new tab strip below the heading)
3. Paste the body of [CONTRACT-DOWNSELL-POLICY-SEED.md](CONTRACT-DOWNSELL-POLICY-SEED.md)
   (everything below the `---` line) into the editor
4. Save. The coach refuses to run until there's an active non-empty
   downsell policy (returns 412 with a guidance message).

### D. Smoke test the coach

1. Open any contract at `/sales/contracts/:id`
2. Scroll past the amendment section — there's a new "Save the deal"
   section at the bottom
3. Click "Open session" and paste a scenario, e.g.:
   > "Client said cash flow is tight, wants to drop to $400/mo for 6 months.
   > They're 4 weeks into the 90-day retainer. Site is launched, GBP rankings
   > are climbing."
4. The coach should:
   - Push back on $400/mo (it's below the $500/mo monthly floor) — status `hard_floor_hit`
   - Propose the $500/mo maintenance + $50/mo hosting structure
   - Attach a `proposed_offer` block with the dollar fields populated
   - You'll see the "Latest recommendation" snapshot appear at the top
     of the thread with the numbers
5. Reply with a follow-up ("they pushed back, said $500 still feels high
   given trouble paying — what about financing the rest of the program?")
   and confirm the coach offers the $4,500-over-3-months finance package.
6. Hit "Lock in offer" once you're satisfied. Thread closes to new
   messages but the snapshot stays visible.

### E. Coach failure modes to watch

- **412 "no active downsell policy"** → step C not done, or saved on the
  Amendment tab by mistake. Check `contract_policy WHERE kind='downsell' AND active=true`.
- **502 "Claude did not call coach_turn"** → very rare, model routing
  issue. Resubmit the same message.
- **Coach quoting amendment rules** → you forgot to redeploy
  `contract-judge-amendment` after migration 021, OR you saved the
  downsell policy on the wrong tab. Check `kind` on the most recent
  policy rows.
