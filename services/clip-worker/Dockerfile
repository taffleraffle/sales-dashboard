# Clip-worker — real ffmpeg in a container so cut/trim/merge/detect has
# full codec support (iPhone HEVC/.mov, etc.) the browser ffmpeg.wasm
# build can't decode. Render Docker web service (free tier / scale-to-
# zero is fine). 2026-06-14.
FROM node:20-slim

# ffmpeg with Debian's full codec set (incl. HEVC decode) — the whole
# reason for going server-side.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=10000
EXPOSE 10000
CMD ["node", "server.js"]
