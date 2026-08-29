# Debian rather than Alpine on purpose: better-sqlite3 ships glibc prebuilds, and the
# ffmpeg-static binary is glibc-linked too. On musl both would have to be built from
# source, which needs a full toolchain in the image.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# python3/make/g++ are only here in case a native prebuild is missing for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies from the tree that gets copied into the runtime image.
RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# fonts-dejavu-core: the thumbnail and title cards need a real TTF for drawtext.
# yt-dlp is optional but small, and without it link clips are silently skipped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# schema.sql is not TypeScript, so tsc does not emit it; the DB layer reads it from here.
COPY src/db/schema.sql ./src/db/schema.sql

# The data volume holds the SQLite database, downloaded clips, and finished reels.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# The bot writes a heartbeat while the gateway is connected; a wedged connection stops
# updating it even though the process is still alive.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "dist/scripts/healthcheck.js"]

CMD ["node", "--enable-source-maps", "dist/src/index.js"]
