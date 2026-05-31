# External submission ingestion + native review — setup checklist

Once the code in this PR is deployed, three manual setup steps are required before the ingestion and review surfaces fully work.

## 1. Apply the migrations

In Supabase Studio → SQL Editor for project `kjfaqhmllagbxjdxlopm`:

1. Paste + run `supabase/migrations/118_external_submission_ingest.sql`
2. Paste + run `supabase/migrations/119_submission_comments.sql`

Both end with `NOTIFY pgrst, 'reload schema'` so PostgREST picks the new columns up immediately.

Verify with:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'lib_task_submissions' AND column_name LIKE 'ingest_%';
-- Expect 6 rows: ingest_status, ingest_source, ingest_started_at,
-- ingest_completed_at, ingest_error_text, ingest_attempt_count

SELECT count(*) FROM lib_submission_comments;
-- Expect 0 (table empty, just created)
```

## 2. Deploy the Edge Function

Two options, pick whichever is easier today:

### Option A — Generate a fresh Supabase PAT, deploy via CLI script

1. https://supabase.com/dashboard/account/tokens → **Generate new token**, scope it to the sales-dashboard project, paste the `sbp_…` value into `sentinel/.env` as `SUPABASE_ACCESS_TOKEN=…`
2. From the repo root:
   ```bash
   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/deploy-ingest-external-submission.mjs
   ```
3. Expect `HTTP 200/201` in the output.

### Option B — Paste the source into Studio

1. Studio → **Edge Functions** → **New function** → name it exactly `ingest-external-submission`
2. Paste the contents of `supabase/functions/ingest-external-submission/index.ts`
3. **Verify JWT** toggle: OFF (the DB trigger and the Retry RPC call this without an auth header)
4. **Deploy**

Verify the function is reachable with a dry run from the SQL editor:

```sql
SELECT net.http_post(
  url := 'https://kjfaqhmllagbxjdxlopm.supabase.co/functions/v1/ingest-external-submission',
  headers := '{"Content-Type": "application/json"}'::jsonb,
  body := '{"submission_id": "00000000-0000-0000-0000-000000000000"}'::jsonb
);
-- Expect a request_id back. The function returns 404 (submission not found),
-- but the fact it RETURNED something means the function is live.
```

## 3. Configure Supabase function secrets

Studio → **Edge Functions** → **Manage secrets** → add the three keys you need (skip the ones for sources you don't use):

| Key | What goes here | Required for |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | The entire service-account JSON file pasted as a single-line string | Google Drive ingest |
| `FRAMEIO_PAT` | Personal Access Token from Frame.io (Settings → Developer → Generate token, scope `assets.read`) | Frame.io ingest |
| `SUPABASE_SERVICE_ROLE_KEY` | Already set by Supabase | Always — used for the DB writes |
| `SUPABASE_URL` | Already set by Supabase | Always |

Dropbox and direct URLs need no secrets (public link / direct download).

### Creating the Google service account (Drive)

1. https://console.cloud.google.com/ → create a project (or reuse one) → **IAM & Admin → Service Accounts → Create**
2. Skip role assignment (we only need Drive API scope, not any GCP role).
3. Open the new service account → **Keys → Add Key → Create new key → JSON** → downloads a JSON file.
4. Enable the Drive API for the project: https://console.cloud.google.com/apis/library/drive.googleapis.com → **Enable**.
5. Copy the service account's email (looks like `ingest-bot@<project>.iam.gserviceaccount.com`).
6. Paste the **entire JSON file contents** as the `GOOGLE_SERVICE_ACCOUNT_KEY` Supabase secret.
7. Tell editors: **share submitted Drive videos with `ingest-bot@<project>.iam.gserviceaccount.com`** (or share the whole submissions folder once). Without this, every Drive ingest fails with "Drive file not found or not shared with service account".

### Frame.io — what actually works in 2026

**Adobe migrated Frame.io to v4 with OAuth2 in 2025 and killed the v2 PAT auth path.** Personal Access Tokens no longer work against share/review URLs. Three options, in descending order of "actually works today":

**Option A (RECOMMENDED) — editors paste the direct media URL**

The most reliable workflow. The edge function's Frame.io path now tries direct-fetch first for any URL containing `assets.frame.io`, `frameioassets.com`, or a video extension.

Tell editors:
1. Open the asset in Frame.io.
2. Right-click the video preview → **Copy media URL** (or use the **Share → Allow downloads → Copy direct link** option).
3. Paste THAT URL into the submission form — not the share/review URL.

The function fetches the URL directly, no auth needed. Works for any video Frame.io serves.

**Option B — legacy v2 PAT fallback (may work on older accounts)**

If your Frame.io account is old enough that v2 endpoints still respond, you can configure a PAT:

1. Sign in to Frame.io → **Settings → Developer → Personal Access Tokens → New Token**.
2. Copy the token (starts with `fio-u-…`). Paste as `FRAMEIO_PAT` Supabase secret.

The function will attempt v2 as a fallback when given a share URL. Most accounts will hit 401 here — that's Adobe's deprecation, not a config bug.

**Option C (NOT BUILT) — full v4 OAuth2 rebuild**

Frame.io v4 requires an Adobe Developer Console project, OAuth2 client_credentials grant via Adobe IMS, and the new `/v4/accounts/{id}/files/{id}` endpoint structure. This is a real piece of work and isn't built yet. If editors absolutely need share-URL ingestion and Option A isn't enough, this is the next chunk.

**Bottom line**: for now, tell editors using Frame.io to use Option A's direct-URL workflow. The other supported sources (Drive, Dropbox, direct CDN URLs) all work without this complication.

## 4. Smoke test

1. Have an editor (or use the dashboard's external-link submitter) post a Frame.io / Drive / Dropbox URL on any active task.
2. In the Activity bell or the EditingQueue submission card, the submission card should appear with a yellow **PULLING** chip immediately.
3. Within ~30s for a small video (or up to a few minutes for larger), the chip should disappear and the **Review** button should appear.
4. Click **Review** → the SubmissionPreviewModal opens with the video playable inline.
5. Add a timestamped comment → click the marker on the scrubber → video should seek to that time.
6. The editor (in `/editor-view`) should see a notification "New comment on vN" with the comment body preview.

## 5. Failure modes you'll see (and what they mean)

| Chip / notification | Meaning | Fix |
|---|---|---|
| "Ingest failed — Drive file not found or not shared…" | The service account doesn't have access | Tell the editor to share the file with the service account email |
| "Ingest failed — Frame.io share URLs aren't supported…" | Adobe killed Frame.io v2 PAT auth in 2025 | Editor pastes the direct media URL (right-click → Copy media URL) instead of the share URL, OR uses Drive/Dropbox |
| "Ingest failed — Dropbox returned HTML" | The Dropbox link is private | Editor needs to set link sharing to "Anyone with the link" |
| "Ingest failed — file too large (XXX MB > 220 MB cap)" | Single video exceeds the edge runtime memory cap | Editor should upload directly via TUS (the existing **Upload file** button on the task modal), which streams to storage |
| "Ingest failed — expected video/* content-type" | The URL doesn't return a video MIME (might be a page, a PDF, etc.) | Verify the URL is a direct video link |

All failure chips have a **Retry** button — click it after fixing the underlying issue (re-share, fix permissions, etc.) and the function re-fires.

## 6. Optional polish (not required for v1)

- **Streaming uploads for >220MB**: the current edge function buffers the full file in memory before re-uploading. Past ~220MB it'll OOM. To support multi-GB files, swap to TUS resumable from inside the edge function (uses the same `tus-js-client` pattern as `AdsCreativeLibrary.uploadWithResume`).
- **Realtime comment sync**: the SubmissionPreviewModal polls comments every 10s. For sub-second sync, swap to a supabase channel on `lib_submission_comments` filtered by `submission_id`.
- **Email notifications on comments**: the `submission_comment` notification already fires into `lib_editor_notifications`. To also send email, mirror the `notify-editor-email` edge function pattern (currently triggered manually from the `notifyEditor` helper in `AdsCreativeLibrary.jsx`).
