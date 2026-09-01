/**
 * Settings that are decisions, not deployment details.
 *
 * Everything here once had an environment variable, and none of them earned it. A value
 * belongs in `.env` when two sensible installations disagree about it — a token, a
 * channel id, how much CPU the host can spare. A value belongs here when there is a
 * right answer and the only reason to change it is that you are changing the product.
 *
 * Edit this file and rebuild to change any of them. That is a deliberate trade: a
 * shorter `.env` that nobody has to read, against a rebuild for tuning nobody does.
 */

/** Crosses that veto a clip. Several, because clients disagree about which one `❌` is. */
export const REJECT_REACTIONS = ['❌', '✖️', '❎'];

/**
 * Who may veto: `owner` (ADMIN_USER_IDS only), `admins`, or `authors`.
 *
 * Defaults to the narrowest option. Widening it hands the power to cancel a clip to
 * more people, which is a decision worth making in code rather than by typo.
 */
export const VETO_ALLOWED: 'owner' | 'admins' | 'authors' = 'owner';

/** Below this a reel is not worth publishing; the clips wait for the next run. */
export const REEL_MIN_CLIPS = 5;

export const video: {
  transitionDuration: number;
  transitions: string[];
  minClipSeconds: number;
  titleCards: boolean;
  titleCardSeconds: number;
  fontFile: string;
  preset: string;
  crf: number;
} = {
  /** Seconds of crossfade between clips. */
  transitionDuration: 0.5,
  transitions: ['fade', 'wipeleft', 'slideup', 'circleopen', 'dissolve'],
  /** Anything shorter is a mis-click or a broken upload, not a clip. */
  minClipSeconds: 2,
  /**
   * Username overlays. Off: they date the footage and clutter the frame, and the
   * credit belongs in Discord where people can actually see it.
   */
  titleCards: false,
  titleCardSeconds: 3,
  /** Empty means "let ffmpeg find one"; only needed if drawtext cannot locate a font. */
  fontFile: '',
  preset: 'veryfast',
  crf: 20,
};

export const thumbnail: { label: string; accent: string } = {
  label: 'GAMING CLIPS',
  /** ffmpeg accepts #RRGGBB, but the 0x form is unambiguous inside a filtergraph. */
  accent: '0xE62117',
};

export const ingest: {
  maxDownloadBytes: number;
  maxLinkBytes: number;
  cookiesFilename: string;
  extractorArgs: string;
  phashThreshold: number;
  minFreeDiskMb: number;
  concurrency: number;
  backfillMaxReels: number;
  maxPendingUploads: number;
  backfillAutoContinue: boolean;
} = {
  /**
   * Per-file download ceiling for Discord attachments, 200MB.
   *
   * Discord's own limits are far lower — 10MB free, 500MB on Nitro — so this is a
   * runaway guard, not a curation rule. `MAX_CLIP_SECONDS` decides what is too long.
   */
  maxDownloadBytes: 209_715_200,
  /**
   * The same ceiling for links, 60MB, and much tighter for a reason: Discord already
   * caps what a member can attach, while a URL could be a three-hour VOD.
   */
  maxLinkBytes: 62_914_560,
  /**
   * Cookie jar filename, looked for inside the data directory.
   *
   * YouTube answers datacenter IPs with "Sign in to confirm you're not a bot", and a
   * signed-in session is what clears it. Drop a Netscape-format `cookies.txt` next to
   * the database and it is picked up; no configuration, and nothing to set when the
   * file is absent — which is most of the time.
   */
  cookiesFilename: 'cookies.txt',
  /**
   * Extra `--extractor-args` for yt-dlp. Empty by default.
   *
   * If YouTube starts refusing downloads, try a different player client here, e.g.
   * `youtube:player_client=tv,web_safari`. Which one works moves around as YouTube
   * changes things, so there is no value worth hard-coding — but update yt-dlp first,
   * which fixes it more often than this does.
   */
  extractorArgs: '',
  /** Hamming distance below which two clips are "the same clip", out of 72 bits. */
  phashThreshold: 8,
  minFreeDiskMb: 3072,
  /** One at a time: the deploy target has two cores and a 3GB memory limit. */
  concurrency: 1,
  /** 0 means unlimited: a backfill keeps building until something else stops it. */
  backfillMaxReels: 0,
  /** Built reels allowed to queue up unuploaded before a backfill pauses itself. */
  maxPendingUploads: 3,
  backfillAutoContinue: true,
};

export const youtube: {
  titleTemplate: string;
  games: string[];
  hashtags: string[];
  description: string;
  tags: string[];
  categoryId: string;
  playlistPrivacy: 'private' | 'unlisted' | 'public';
} = {
  titleTemplate: 'Discord Gaming Clips #{n} | CS2, Rocket League, LoL & More',
  games: [
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
  ],
  hashtags: [
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
  ],
  /** Empty means the generated description is used. */
  description: '',
  tags: [
    'gaming clips',
    'funny gaming moments',
    'variety gaming',
    'cs2 clips',
    'counter strike 2',
    'rocket league clips',
    'league of legends clips',
    'rust clips',
    'valorant clips',
    'fortnite clips',
    'gaming montage',
    'discord clips',
    'funny fails',
    'gaming highlights',
    'arabic gaming',
    'العاب',
    'كليبات جيمنج',
    'gameplay',
    'best moments',
  ],
  /** 20 is "Gaming" in YouTube's category list. */
  categoryId: '20',
  playlistPrivacy: 'public',
};
