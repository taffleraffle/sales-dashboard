# clip-worker

Real-ffmpeg microservice for the creative-library Clip Editor. Replaces
the browser ffmpeg.wasm path, which can't decode iPhone HEVC/.mov and
forces a 32 MB client download.

## Why server-side
- Full codec support (the container's ffmpeg has HEVC, etc.)
- No 32 MB browser engine download
- The Supabase **service-role key never reaches the browser** — it lives
  only in this service's env. Heavy CPU is off the user's machine.

## Deploy (Render, Docker, scale-to-zero)
Root dir `services/clip-worker`, Docker runtime. Env:

| var | value |
|---|---|
| `SUPABASE_URL` | https://kjfaqhmllagbxjdxlopm.supabase.co |
| `SUPABASE_SERVICE_ROLE_KEY` | (secret — Supabase dashboard → Project Settings → API) |
| `WORKER_SECRET` | random; optional service-to-service key |
| `UPLOAD_BUCKET` | creative-uploads |
| `ALLOW_ORIGIN` | https://sales-dashboard-ftct.onrender.com |

## API (JSON; browser sends `Authorization: Bearer <supabase user jwt>`)
- `GET /health` → `{ ok, ffmpeg, storage }`
- `POST /detect { sourceUrl }` → `{ cuts: [seconds] }` (silence-gap take boundaries)
- `POST /render { sourceUrl, segments:[{in,out,reencode,label}], merge, outBase }`
  → `{ results: [{ kind, path, url }] }`

Render rules: lossless stream-copy concat for whole-file untrimmed
merges; libx264 re-encode for any trim; stream-copy for untrimmed cuts.

## Verified
Parsers (silencedetect → cuts, duration) unit-tested; HTTP/auth/CORS
boot-tested. ffmpeg execution is verified post-deploy via `/health` +
a real-video `/detect` + `/render` curl.
