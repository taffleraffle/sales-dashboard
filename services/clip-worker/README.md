# clip-worker

Stateless real-ffmpeg microservice for the creative-library Clip Editor.
Replaces the browser ffmpeg.wasm path (can't decode iPhone HEVC/.mov,
32 MB client download, unverifiable).

## Why server-side
- Full codec support (container ffmpeg has HEVC, etc.)
- No 32 MB browser engine download
- **No Supabase service-role key.** The browser uploads the source with
  its own login and passes the public URL; the worker fetches, processes,
  and returns the finished MP4 bytes; the browser saves them. The worker's
  only secret is the public anon key (to verify caller JWTs).

## Deploy (Render, Docker)
Root dir `services/clip-worker`, Docker runtime, free tier is fine. Env:

| var | value |
|---|---|
| `SUPABASE_URL` | https://kjfaqhmllagbxjdxlopm.supabase.co |
| `SUPABASE_ANON_KEY` | the public anon key (same one in the web bundle) |
| `WORKER_SECRET` | random; for service-to-service + /selftest |
| `ALLOW_ORIGIN` | https://sales-dashboard-ftct.onrender.com |

## API (auth: `X-Worker-Key` OR `Authorization: Bearer <supabase jwt>`)
- `GET  /health`  → `{ ok, ffmpeg, hevc, scene }`
- `POST /detect`  `{ sourceUrl }` → `{ cuts:[s], duration }` (silence + scene cuts)
- `POST /cut`     `{ sourceUrl, in, out, reencode }` → mp4 bytes
- `POST /merge`   `{ parts:[{sourceUrl,in,out}], reencode }` → mp4 bytes
- `POST /selftest` → `{ pass, steps[] }` — synthetic 3-take footage built
  in-container, detect/cut/merge verified. One curl proves the pipeline.

## QA
After deploy: `curl -X POST $URL/selftest -H "X-Worker-Key: $SECRET"` →
`{ pass: true, steps: [...] }`.
