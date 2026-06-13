# Clip-worker — real ffmpeg in a container so cut/trim/merge has full
# codec support (iPhone HEVC/.mov, etc.) that the browser ffmpeg.wasm
# build can't decode. Deployed as its own Render web service (scale to
# zero). 2026-06-13.
FROM node:20-slim

# ffmpeg with the full codec set Debian ships (incl. HEVC decode via
# libde265 / built-in hevc). This is the whole point of going server-side.
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
