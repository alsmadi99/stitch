import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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
  REJECT_REACTION: csv(['❌', '✖️', '❎']),
  VETO_ALLOWED: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'owner' : v.trim()))
    .pipe(z.enum(['owner', 'admins', 'authors'])),

  REEL_MAX_CLIPS: num(20),
  REEL_MIN_CLIPS: num(5),
  REEL_CRON: str('0 18 * * 0'),

  OUTPUT_WIDTH: num(1920),
  OUTPUT_HEIGHT: num(1080),
  OUTPUT_FPS: num(30),
  TRANSITION_DURATION: num(0.5),
  TRANSITIONS: csv(['fade', 'wipeleft', 'slideup', 'circleopen', 'dissolve']),
  MAX_CLIP_SECONDS: num(60),
  MIN_CLIP_SECONDS: num(2),
  TITLE_CARDS: bool(false),
  TITLE_CARD_SECONDS: num(3),
  FONT_FILE: str(),
  X264_PRESET: str('veryfast'),
  X264_CRF: num(20),
  FFMPEG_THREADS: num(0),
  STITCH_BATCH: num(4),

  THUMBNAIL_LABEL: str('GAMING CLIPS'),
  THUMBNAIL_ACCENT: str('0xE62117'),

  MAX_DOWNLOAD_BYTES: num(209_715_200),
  ALLOW_LINKS: bool(true),
  /**
   * Who may have a link fetched on their behalf. Empty means anyone in the channel.
   *
   * A link costs a yt-dlp run against a third-party site, which is a far bigger lever
   * than posting a file — so it is worth being able to hand it to a few people only.
   */
  LINK_ALLOWED_USER_IDS: csv(),
  /**
   * Size cap for links specifically, separate from `MAX_DOWNLOAD_BYTES`.
   *
   * A Discord upload is already capped by Discord. A YouTube link is not: the same URL
   * can be a 30-second clip or a three-hour VOD, and only the cap stops the latter.
   */
  MAX_LINK_BYTES: num(62_914_560),
  PHASH_THRESHOLD: num(8),
  MIN_FREE_DISK_MB: num(2048),
  INGEST_CONCURRENCY: num(2),
  BACKFILL_MAX_REELS: num(0),
  MAX_PENDING_UPLOADS: num(3),
  BACKFILL_AUTO_CONTINUE: bool(true),

  YOUTUBE_CLIENT_ID: str(),
  YOUTUBE_CLIENT_SECRET: str(),
  YOUTUBE_REFRESH_TOKEN: str(),
  YOUTUBE_PRIVACY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'private' : v.trim()))
    .pipe(z.enum(['private', 'unlisted', 'public'])),
  YOUTUBE_AUTO_PUBLISH: bool(false),
  YOUTUBE_TITLE_TEMPLATE: str('Discord Gaming Clips #{n} | CS2, Rocket League, LoL & More'),
  YOUTUBE_GAMES: csv([
    'CS2',
    'Rocket League',
    'League of Legends',
    'Rust',
    'Valorant',
    'Fortnite',
    'GTA V',
    'Minecraft',
    'Apex Legends',
    'Call of Duty',
  ]),
  YOUTUBE_HASHTAGS: csv([
    'gaming',
    'funny',
    'clips',
    'arabic',
    'cs2',
    'rocketleague',
    'leagueoflegends',
    'rust',
    'valorant',
    'fortnite',
    'gameplay',
    'montage',
    'fails',
    'highlights',
  ]),
  YOUTUBE_DESCRIPTION: str(),
  YOUTUBE_TAGS: csv([
    'gaming clips',
    'funny gaming moments',
    'variety gaming',
    'cs2 clips',
    'rocket league clips',
    'league of legends clips',
    'rust clips',
    'gaming montage',
    'discord clips',
    'gaming highlights',
    'arabic gaming',
  ]),
  YOUTUBE_CATEGORY_ID: str('20'),
  YOUTUBE_PLAYLIST_ID: str(),
  YOUTUBE_PLAYLIST_TITLE: str(),
  YOUTUBE_PLAYLIST_PRIVACY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? 'public' : v.trim()))
    .pipe(z.enum(['private', 'unlisted', 'public'])),

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
    rejectReactions: env.REJECT_REACTION,
    vetoAllowed: env.VETO_ALLOWED,
  },
  trigger: {
    maxClips: env.REEL_MAX_CLIPS,
    minClips: env.REEL_MIN_CLIPS,
    cron: env.REEL_CRON,
  },
  video: {
    width: env.OUTPUT_WIDTH,
    height: env.OUTPUT_HEIGHT,
    fps: env.OUTPUT_FPS,
    transitionDuration: env.TRANSITION_DURATION,
    transitions: env.TRANSITIONS,
    maxClipSeconds: env.MAX_CLIP_SECONDS,
    minClipSeconds: env.MIN_CLIP_SECONDS,
    titleCards: env.TITLE_CARDS,
    titleCardSeconds: env.TITLE_CARD_SECONDS,
    fontFile: env.FONT_FILE || undefined,
    preset: env.X264_PRESET,
    crf: env.X264_CRF,
    threads: env.FFMPEG_THREADS,
    stitchBatch: Math.max(2, env.STITCH_BATCH),
  },
  thumbnail: {
    label: env.THUMBNAIL_LABEL,
    // ffmpeg accepts #RRGGBB, but 0x form avoids any ambiguity inside a filtergraph.
    accent: env.THUMBNAIL_ACCENT.replace(/^#/, '0x'),
  },
  ingest: {
    maxDownloadBytes: env.MAX_DOWNLOAD_BYTES,
    allowLinks: env.ALLOW_LINKS,
    linkAllowedUserIds: env.LINK_ALLOWED_USER_IDS,
    maxLinkBytes: env.MAX_LINK_BYTES,
    phashThreshold: env.PHASH_THRESHOLD,
    minFreeDiskMb: env.MIN_FREE_DISK_MB,
    concurrency: Math.max(1, env.INGEST_CONCURRENCY),
    // 0 means unlimited: keep building until something else says stop.
    backfillMaxReels: env.BACKFILL_MAX_REELS > 0 ? env.BACKFILL_MAX_REELS : Number.POSITIVE_INFINITY,
    maxPendingUploads: Math.max(1, env.MAX_PENDING_UPLOADS),
    backfillAutoContinue: env.BACKFILL_AUTO_CONTINUE,
  },
  youtube: {
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    refreshToken: env.YOUTUBE_REFRESH_TOKEN,
    privacy: env.YOUTUBE_PRIVACY,
    autoPublish: env.YOUTUBE_AUTO_PUBLISH,
    titleTemplate: env.YOUTUBE_TITLE_TEMPLATE,
    games: env.YOUTUBE_GAMES,
    hashtags: env.YOUTUBE_HASHTAGS,
    description: env.YOUTUBE_DESCRIPTION,
    tags: env.YOUTUBE_TAGS,
    categoryId: env.YOUTUBE_CATEGORY_ID,
    playlistId: env.YOUTUBE_PLAYLIST_ID,
    playlistTitle: env.YOUTUBE_PLAYLIST_TITLE,
    playlistPrivacy: env.YOUTUBE_PLAYLIST_PRIVACY,
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
