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

# Drop dev dependencies, and the optional ffmpeg/ffprobe static binaries — they carry
# ~410MB of per-platform builds and the runtime image uses the distro ffmpeg instead.
RUN npm prune --omit=dev --omit=optional


FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# The yt-dlp plugin that answers YouTube's "prove you are not a bot" challenge. It
# talks to the `pot` sidecar over HTTP; with that service absent it logs a warning and
# yt-dlp carries on unaided, so this is safe to ship either way.
# Pinned: a plugin that changes under you breaks downloads at an unrelated moment.
ARG POT_PLUGIN_VERSION=1.3.2

# Distro ffmpeg rather than the bundled ffmpeg-static binary: the static Linux build
# ships without libfreetype, so it has no drawtext filter and every thumbnail label
# fails. Debian's build has it. fonts-dejavu-core supplies the TTF it renders with.
# yt-dlp is optional but small; without it link clips are skipped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates ffmpeg fonts-dejavu-core gosu curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && mkdir -p /etc/yt-dlp/plugins \
  && curl -fsSL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${POT_PLUGIN_VERSION}/bgutil-ytdlp-pot-provider.zip" \
       -o /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

# --chown on the COPY itself. A separate `chown -R` would rewrite every file and
# duplicate the whole node_modules tree into a second layer.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# schema.sql is not TypeScript, so tsc does not emit it; the DB layer reads it from here.
COPY --chown=node:node src/db/schema.sql ./src/db/schema.sql

# The data volume holds the SQLite database, downloaded clips, and finished reels.
# A bind mount replaces this directory at runtime, so the entrypoint re-applies
# ownership; this chown only matters for named volumes, which inherit it from here.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# The entrypoint runs as root only long enough to fix the data directory's ownership,
# then execs the app as this uid. Override if the host directory belongs to someone
# other than 1000.
ENV APP_UID=1000 \
    APP_GID=1000

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

EXPOSE 3000

# The bot writes a heartbeat while the gateway is connected; a wedged connection stops
# updating it even though the process is still alive. Run as the app user so it reads
# the same paths the app writes.
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["gosu", "1000:1000", "node", "dist/scripts/healthcheck.js"]

CMD ["node", "--enable-source-maps", "dist/src/index.js"]
