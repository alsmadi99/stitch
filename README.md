# clipreel

Discord bot that watches a clips channel, keeps only the unique clips, and compiles
them into a single video with crossfades that it uploads to YouTube — weekly, or as
soon as the queue hits 20 clips.

```
#gaming-clips ──▶ ingest ──▶ dedupe ──▶ SQLite queue
                                             │
                        20 clips  or  weekly cron
                                             ▼
                          ffmpeg normalize ──▶ xfade stitch
                                             ▼
                       YouTube upload (private) ──▶ Discord approve button
```

## Requirements

- Node 20.11+
- ffmpeg — bundled via `ffmpeg-static`, nothing to install
- `yt-dlp` on `PATH` — **optional**, only needed for link clips (Medal, Streamable,
  Twitch, YouTube). Without it those are skipped and uploaded attachments still work.

## Setup

```bash
npm install
cp .env.example .env
```

### Discord

1. Create an application at <https://discord.com/developers/applications>, add a bot,
   copy the token into `DISCORD_TOKEN` and the application ID into `DISCORD_APP_ID`.
2. In **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Without
   it attachments and links arrive empty and the bot collects nothing.
3. Invite the bot with the `bot` and `applications.commands` scopes and the
   *Read Messages*, *Read Message History*, *Send Messages*, and *Add Reactions*
   permissions.
4. Put the clips channel ID in `CLIPS_CHANNEL_ID` (right-click the channel → Copy ID,
   with Developer Mode on) and your guild ID in `DISCORD_GUILD_ID` so slash commands
   register instantly instead of taking an hour to propagate globally.

### YouTube

1. In Google Cloud Console, enable **YouTube Data API v3**.
2. Create an OAuth client of type **Web application** and add
   `http://localhost:8787/oauth2callback` as an authorized redirect URI.
3. While the app is in *Testing*, add your Google account under **Test users**.
4. Fill in `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET`, then run:

```bash
npm run youtube:auth
```

Open the printed URL, grant access, and copy the resulting `YOUTUBE_REFRESH_TOKEN`
into `.env`.

Leave the YouTube variables blank to run in local-only mode — reels are compiled to
`data/out/` and announced in Discord without being uploaded.

## Running

```bash
npm run dev
```

```bash
npm run build
npm start
```

Check every integration point before the first real run:

```bash
npm run doctor
```

It verifies the env file, the ffmpeg binaries, yt-dlp, the database, the Discord login
and channel permissions, the Message Content intent, and the YouTube token — without
posting, uploading, or changing anything.

Useful one-offs:

```bash
npm run backfill -- 1000
```

```bash
npm run reel:now
```

## Slash commands

| Command           | What it does                                                  |
| ----------------- | ------------------------------------------------------------- |
| `/clips status`   | Queue size, whether a reel is compiling, and the last reel     |
| `/clips backfill` | Scans channel history for clips posted before the bot joined   |
| `/reel build`     | Compiles now, ignoring the threshold                           |
| `/reel publish`   | Flips the latest uploaded reel to public                       |

Access defaults to anyone with **Manage Server**; set `ADMIN_ROLE_IDS` to restrict it
to specific roles.

The bot reacts to each clip message: ✅ queued, ♻️ duplicate, ⚠️ rejected.

## How deduplication works

Three layers, cheapest first:

1. **Message identity** — a `UNIQUE (message_id, source_url)` constraint, so restarts
   and overlapping backfills never re-ingest the same post.
2. **SHA-256 of the file bytes** — catches the same file reposted verbatim.
3. **Perceptual fingerprint** — five frames sampled at 10/30/50/70/90% of the clip,
   each reduced to a 64-bit dHash. Two clips are the same when their mean Hamming
   distance is under `PHASH_THRESHOLD` (default 8) *and* their durations are within
   1.5s of each other.

Layer 3 is the one that matters in practice: it catches a clip re-uploaded through
Medal, or trimmed and recompressed by a different capture tool. Measured on
synthetic footage, a clip rescaled to half resolution at CRF 34 scored 0.8 against
its original while unrelated footage scored 22–38, so the default threshold has a
wide margin on both sides.

## How the video is built

Each clip is re-encoded to a common format first, because `xfade` refuses to join
inputs that differ in resolution, frame rate, or pixel format:

- letterboxed into `OUTPUT_WIDTH`×`OUTPUT_HEIGHT` (never stretched), `OUTPUT_FPS`,
  yuv420p, SAR 1:1
- stereo 48 kHz AAC, passed through `loudnorm` so one screaming clip does not blow
  out the mix; clips with no audio get a synthesized silent track
- trimmed to `MAX_CLIP_SECONDS`
- the contributor's name burned into the first `TITLE_CARD_SECONDS` (the name is
  passed to `drawtext` through a text file, so punctuation in display names cannot
  break the filtergraph)

Then one `ffmpeg` invocation chains `xfade` (video) and `acrossfade` (audio) across
every clip. Joining N clips of total length `D` with transition `T` yields
`D - (N-1)*T` seconds, and the k-th join sits at `sum(durations[0..k-1]) - k*T`.
Normalized durations are re-measured with ffprobe before computing those offsets,
because `loudnorm` and frame-rate conversion shift lengths by a few frames.

If any clip is shorter than twice the transition, the transition is shortened for the
whole reel rather than swallowing that clip.

The description gets a timestamp per clip, which YouTube turns into chapters — but
only when there are 3+ chapters and every one is at least 10s. Below that it falls
back to a plain credits list.

## Gotchas worth knowing

- **Unverified Google Cloud projects can only upload private videos.** The API accepts
  `privacyStatus: "public"` and silently locks the video as private anyway. Until you
  pass API verification, treat the Discord approve button (or Studio) as the publish
  step. The default `YOUTUBE_PRIVACY=private` + `YOUTUBE_AUTO_PUBLISH=false` matches
  this reality.
- **A Google app left in "Testing" invalidates its refresh token every 7 days.** The
  bot then fails every upload until you re-run `npm run youtube:auth`. Set the app's
  publishing status to **In production** on the Google Auth Platform screen — that is
  allowed without verification, it just shows an "unverified app" warning during
  consent and caps you at 100 users.
- **Quota.** One upload costs 1600 of the default 10,000 units/day. Weekly reels are
  nowhere near the ceiling; hammering `/reel build` is.
- **Discord CDN links expire.** Attachment URLs are signed and short-lived, which is
  why clips are downloaded the moment the message arrives, and why backfill re-fetches
  messages through the API instead of trusting stored URLs.
- **Copyright.** Clips with game soundtracks or streamer audio can pick up Content ID
  claims. That is a channel-policy problem, not something the bot can detect.
- **Consent.** The bot reposts members' clips to a public channel under their display
  name. Say so in the channel topic.
- One compile runs at a time. A threshold trigger firing mid-run is skipped, not
  queued; the clips stay in the queue for the next run.
- If a run fails at any stage its clips are returned to the queue, so a bad upload
  never costs you a week of submissions.

## Troubleshooting

**`doctor` says the account has no YouTube channel.** `channels.list({ mine: true })`
came back empty, which means one of two things:

- The Google account has never created a channel. A Google account and a YouTube
  channel are separate things — signing in to YouTube does not create one. Open
  <https://youtube.com>, signed in as the account `doctor` names, and create a channel.
- The channel exists but belongs to a **Brand Account**, and consent was granted to the
  personal account instead. `npm run youtube:auth` shows a channel picker after the
  account picker; choosing the personal account yields a valid token with no channel
  behind it. Revoke at <https://myaccount.google.com/permissions>, re-run
  `npm run youtube:auth`, and pick the channel.

The account `doctor` prints comes from the `userinfo.email` scope. Tokens minted before
that scope was added still work; they just report the account as unknown.

**`invalid_grant` on upload after about a week.** The Google app is still in *Testing*
— see the publishing-status gotcha above.

## Configuration

Every option lives in `.env` — see `.env.example` for the full annotated list. The
ones you are most likely to touch:

| Variable              | Default             | Notes                                          |
| --------------------- | ------------------- | ---------------------------------------------- |
| `REEL_MAX_CLIPS`      | `20`                | Threshold that fires a reel immediately        |
| `REEL_MIN_CLIPS`      | `5`                 | Floor for the weekly run                       |
| `REEL_CRON`           | `0 18 * * 0`        | Sunday 18:00, honours `TZ`                     |
| `TRANSITION_DURATION` | `0.5`               | Crossfade length in seconds                    |
| `TRANSITIONS`         | `fade,wipeleft,…`   | Any `xfade` transition names, used round-robin |
| `MAX_CLIP_SECONDS`    | `60`                | Longer clips are trimmed                       |
| `PHASH_THRESHOLD`     | `8`                 | Raise to catch more duplicates, lower if false positives appear |
| `YOUTUBE_AUTO_PUBLISH`| `false`             | `true` skips the approval button               |
| `X264_PRESET`         | `veryfast`          | `slow` for smaller files, much longer compiles |

For a vertical Shorts cut, set `OUTPUT_WIDTH=1080`, `OUTPUT_HEIGHT=1920` and
`MAX_CLIP_SECONDS` low enough to keep the reel under 60s.

## Layout

```
src/
  config.ts          env parsing and validation (zod), creates data dirs
  pipeline.ts        select clips → compile → upload → announce, with the run lock
  db/                SQLite schema and the clips/reels repositories
  discord/           client, message collector, slash commands, announcements
  ingest/            download, ffprobe metadata, hashing and fingerprinting
  video/             ffmpeg runner, per-clip normalize, xfade stitch, thumbnail
  youtube/           OAuth, metadata builder, resumable upload
  scheduler/         weekly cron and the threshold check
scripts/
  youtube-auth.ts    one-time consent flow that prints the refresh token
  backfill.ts        ingest channel history
  run-now.ts         compile and upload immediately
```

State lives in `data/`: `clipreel.db`, downloaded clips in `raw/`, intermediates in
`work/`, finished reels in `out/`. Set `CLEANUP_SOURCES=true` to delete source clips
once their reel is uploaded.
