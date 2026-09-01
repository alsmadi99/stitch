import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as K from './constants.js';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

// An empty value means "unset", not "empty string" — dotenv yields '' for a bare key,
// and for a value like `#E62117` where it strips everything after the # as a comment.
const str = (def = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()));

const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APP_ID: z.string().min(1, 'DISCORD_APP_ID is required'),
  DISCORD_GUILD_ID: str(),
  CLIPS_CHANNEL_ID: z.string().min(1, 'CLIPS_CHANNEL_ID is required'),
  ANNOUNCE_CHANNEL_ID: str(),
  ADMIN_ROLE_IDS: csv(),
  ADMIN_USER_IDS: csv(),

  REEL_MAX_CLIPS: num(20),
  REEL_CRON: str('0 18 * * 0'),

  // Host-shaped: these are the knobs that depend on the machine, not on taste.
  OUTPUT_WIDTH: num(1920),
  OUTPUT_HEIGHT: num(1080),
  OUTPUT_FPS: num(30),
  MAX_CLIP_SECONDS: num(60),
  FFMPEG_THREADS: num(0),

  /**
   * Whether a posted link is followed and downloaded, or ignored.
   *
   * Off: attachments are what members actually post, and a link is someone else's video
   * going into a monetized compilation. YouTube also refuses the deploy host as bot
   * traffic, so those links only ever produced rejected rows.
   */
  ALLOW_LINKS: bool(false),
  /** Who may have a link fetched on their behalf. Empty means anyone in the channel. */
  LINK_ALLOWED_USER_IDS: csv(),

  YOUTUBE_CLIENT_ID: str(),
  YOUTUBE_CLIENT_SECRET: str(),
  YOUTUBE_REFRESH_TOKEN: str(),
  YOUTUBE_PRIVACY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'private' : v.trim()))
    .pipe(z.enum(['private', 'unlisted', 'public'])),
  YOUTUBE_AUTO_PUBLISH: bool(false),
  YOUTUBE_PLAYLIST_ID: str(),
  YOUTUBE_PLAYLIST_TITLE: str(),

  HTTP_PORT: num(3000),
  LOG_LEVEL: str('info'),
  DATA_DIR: str('./data'),
  CLEANUP_SOURCES: bool(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(
    `Invalid environment configuration:\n${issues}\n\nSet these in .env — .env.example documents each one.`,
  );
}

const env = parsed.data;
const dataDir = path.resolve(process.cwd(), env.DATA_DIR);

export const config = {
  discord: {
    token: env.DISCORD_TOKEN,
    appId: env.DISCORD_APP_ID,
    guildId: env.DISCORD_GUILD_ID || undefined,
    clipsChannelId: env.CLIPS_CHANNEL_ID,
    announceChannelId: env.ANNOUNCE_CHANNEL_ID || env.CLIPS_CHANNEL_ID,
    adminRoleIds: env.ADMIN_ROLE_IDS,
    adminUserIds: env.ADMIN_USER_IDS,
    rejectReactions: K.REJECT_REACTIONS,
    vetoAllowed: K.VETO_ALLOWED,
  },
  trigger: {
    maxClips: env.REEL_MAX_CLIPS,
    minClips: K.REEL_MIN_CLIPS,
    cron: env.REEL_CRON,
  },
  video: {
    width: env.OUTPUT_WIDTH,
    height: env.OUTPUT_HEIGHT,
    fps: env.OUTPUT_FPS,
    transitionDuration: K.video.transitionDuration,
    transitions: [...K.video.transitions],
    maxClipSeconds: env.MAX_CLIP_SECONDS,
    minClipSeconds: K.video.minClipSeconds,
    titleCards: K.video.titleCards,
    titleCardSeconds: K.video.titleCardSeconds,
    fontFile: K.video.fontFile || undefined,
    preset: K.video.preset,
    crf: K.video.crf,
    threads: env.FFMPEG_THREADS,
  },
  thumbnail: {
    label: K.thumbnail.label,
    accent: K.thumbnail.accent,
  },
  ingest: {
    maxDownloadBytes: K.ingest.maxDownloadBytes,
    allowLinks: env.ALLOW_LINKS,
    linkAllowedUserIds: env.LINK_ALLOWED_USER_IDS,
    maxLinkBytes: K.ingest.maxLinkBytes,
    ytdlpCookiesFile: path.join(dataDir, K.ingest.cookiesFilename),
    ytdlpExtractorArgs: K.ingest.extractorArgs,
    phashThreshold: K.ingest.phashThreshold,
    minFreeDiskMb: K.ingest.minFreeDiskMb,
    concurrency: K.ingest.concurrency,
    // 0 means unlimited: keep building until something else says stop.
    backfillMaxReels: K.ingest.backfillMaxReels > 0 ? K.ingest.backfillMaxReels : Number.POSITIVE_INFINITY,
    maxPendingUploads: K.ingest.maxPendingUploads,
    backfillAutoContinue: K.ingest.backfillAutoContinue,
  },
  youtube: {
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN,
    privacy: env.YOUTUBE_PRIVACY,
    autoPublish: env.YOUTUBE_AUTO_PUBLISH,
    titleTemplate: K.youtube.titleTemplate,
    games: [...K.youtube.games],
    hashtags: [...K.youtube.hashtags],
    description: K.youtube.description,
    tags: [...K.youtube.tags],
    categoryId: K.youtube.categoryId,
    playlistId: env.YOUTUBE_PLAYLIST_ID,
    playlistTitle: env.YOUTUBE_PLAYLIST_TITLE,
    playlistPrivacy: K.youtube.playlistPrivacy,
    enabled: Boolean(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET && env.YOUTUBE_REFRESH_TOKEN),
  },
  paths: {
    dataDir,
    rawDir: path.join(dataDir, 'raw'),
    workDir: path.join(dataDir, 'work'),
    outDir: path.join(dataDir, 'out'),
    dbFile: path.join(dataDir, 'stitch.db'),
  },
  http: {
    port: env.HTTP_PORT,
  },
  logLevel: env.LOG_LEVEL,
  cleanupSources: env.CLEANUP_SOURCES,
} as const;

// The project was called clipreel before it was called stitch. An existing deployment
// has its whole history — dedupe fingerprints, episode numbering, the backfill cursor —
// in the old file, and silently starting a fresh database would re-upload everything.
const legacyDb = path.join(dataDir, 'clipreel.db');
if (fs.existsSync(legacyDb) && !fs.existsSync(config.paths.dbFile)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(legacyDb + suffix)) fs.renameSync(legacyDb + suffix, config.paths.dbFile + suffix);
  }
}

// Every subsystem assumes these exist; create them once, here, rather than in whichever
// module happens to run first.
for (const dir of [config.paths.dataDir, config.paths.rawDir, config.paths.workDir, config.paths.outDir]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Cannot write to ${dir} (${code}).

` +
          'In Docker this means the mounted data directory is owned by another user. ' +
          `Fix it on the host with: chown -R 1000:1000 <host data dir>
` +
          'A named volume avoids this entirely — see docker-compose.yml.',
      );
    }
    throw err;
  }
}

export type Config = typeof config;
