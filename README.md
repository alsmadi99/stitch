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
                       YouTube upload (private) ──▶ link posted to Discord
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
npm run reel:now
```

## Backfilling the whole channel

Walks the channel from its very first message, ingests every video in it, and uploads
them as reels of at most `REEL_MAX_CLIPS` — the same 20-clip format as a normal week.

```bash
npm run backfill
```

Images, screenshots, links to image hosts, and plain text are filtered out before
anything is downloaded, so a chatty channel costs nothing but the history scan.

The reel is built as soon as the queue is deep enough, not after the whole scan. That
is what keeps disk flat: roughly 20 clips are on disk at any moment rather than the
channel's entire video history. With `CLEANUP_SOURCES=true` each batch's sources are
deleted once its reel is uploaded.

Position is checkpointed after every page and before every compile, so the run is safe
to stop, restart, or redeploy mid-way — it resumes instead of re-downloading.

```bash
npm run backfill -- --restart
```

```bash
npm run backfill -- --limit 500 --reels 2
```

```bash
npm run backfill -- --scan-only
```

`/clips backfill` does the same thing from Discord. It replies immediately and keeps
running in the background, because a full history walk outlives the 15-minute
interaction token; watch it with `/clips status`.

**It will stop before finishing the first time, and that is expected.** YouTube allows
10,000 quota units a day and charges 1,600 per upload, so six uploads is the hard
daily ceiling. `BACKFILL_MAX_REELS` (default 5) stops the run cleanly below it, and a
quota error mid-run is caught rather than burning the rest of the queue on failures.
Run it again the next day to continue where it stopped.

## Slash commands

| Command         | Who                | What it does                                    |
| --------------- | ------------------ | ----------------------------------------------- |
| `/clips status` | `ADMIN_ROLE_IDS`   | Queue size, whether a reel is compiling, last reel |
| `/reel build`   | `ADMIN_USER_IDS`   | Compiles now, ignoring the threshold            |
| `/reel publish` | `ADMIN_USER_IDS`   | Attempts to flip the latest uploaded reel public |

**Backfill is not a Discord command.** It walks the whole channel, downloads gigabytes,
and uploads several videos against a quota that allows six a day. One mistaken
invocation costs a day of uploads and cannot be recalled, so it lives in
`scripts/backfill.ts` and runs from the server only.

`/reel build` and `/reel publish` spend upload quota, so they are gated on
`ADMIN_USER_IDS` — a list of Discord **user** IDs, not roles. Leave it blank and those
commands are **not registered at all**; there is no permission fallback, because there
is no safe default answer to who may publish to your channel. The handler re-checks the
allowlist on every invocation, so a registration left over from an earlier config
cannot become an open door.

`/clips status` is read-only and uses `ADMIN_ROLE_IDS`, falling back to **Manage
Server** when that is unset.

When a reel is uploaded the bot posts the YouTube link on its own — no embed, no
buttons, no call to action. Discord unfurls the link into a player card itself.

The bot reacts to each clip message: ✅ queued, ♻️ duplicate, ⚠️ rejected.

## Restarts and redeploys

Clips are marked `used` before compiling begins, and compiling takes minutes. If the
process dies in that window — a redeploy, an OOM kill, a host reboot — the failure
handler never runs, and without recovery those clips would stay attached to a reel
stuck in `building`: silently excluded from every future reel.

So on every startup the bot releases the clips of any reel left in `building` or
`uploading`, marks that reel failed, and deletes the normalize/stitch intermediates a
killed run left in `data/work/`. Nothing is lost and no disk leaks. A failed reel does
not consume an episode number either, so numbering stays contiguous.

What actually happens if you deploy mid-run:

| Interrupted during | Result                                                        |
| ------------------ | -------------------------------------------------------------- |
| Compiling          | Clips return to the queue on restart; the next reel includes them |
| Uploading          | Same. The abandoned resumable session expires on YouTube's side  |
| Backfill           | The process ends. Re-run it — the cursor resumes where it stopped |

A backfill is a one-off command, not a service, so it does **not** restart itself after
a redeploy. Re-run the same command; already-scanned messages are skipped and
already-downloaded clips are still queued.

Shutdown is deliberately immediate rather than waiting for the current compile: the
stop grace period is seconds and a compile is minutes, so waiting only delays the
inevitable kill. The log says plainly when it happens.

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
- optionally, the contributor's name burned into the first `TITLE_CARD_SECONDS`. Off
  by default (`TITLE_CARDS=false`); when on, the name is passed to `drawtext` through a
  text file so punctuation in display names cannot break the filtergraph

Then one `ffmpeg` invocation chains `xfade` (video) and `acrossfade` (audio) across
every clip. Joining N clips of total length `D` with transition `T` yields
`D - (N-1)*T` seconds, and the k-th join sits at `sum(durations[0..k-1]) - k*T`.
Normalized durations are re-measured with ffprobe before computing those offsets,
because `loudnorm` and frame-rate conversion shift lengths by a few frames.

If any clip is shorter than twice the transition, the transition is shortened for the
whole reel rather than swallowing that clip.

## Thumbnail

Every episode gets a generated 1280x720 thumbnail with the same furniture, so the
playlist reads as a series: an accent badge with `#N` top-right, an accent rule, and a
darkened band carrying `THUMBNAIL_LABEL` across the bottom.

The background is not a fixed-offset frame grab — that reliably lands on a loading
screen, a crossfade, or a dark corner. 24 frames are sampled across the finished reel,
scored on colourfulness, contrast, and distance from a mid-tone exposure, and the
winner is used. Output is around 60KB, far under YouTube's 2MB thumbnail limit.

Custom thumbnails require a verified channel. If YouTube rejects it the upload still
succeeds — the failure is logged and skipped, not fatal.

## Description and tags

The description is generic and identical in shape for every episode: one line naming
the series and episode number, the games covered, and a hashtag block. No per-clip
breakdown, no contributor list. `YOUTUBE_GAMES` sets the game list;
`YOUTUBE_DESCRIPTION` replaces the whole body if you would rather write your own.

Two limits are enforced in code rather than left to fail silently:

- **Hashtags** are truncated to 15. Past 15, YouTube ignores *every* hashtag on the
  video, not just the excess.
- **Tags** are added until the combined 500-character budget runs out, then the rest
  are dropped with a warning.

## Monetization

It cannot be turned on through the YouTube Data API — there is no field for it on a
regular channel's videos. It is a channel-level setting:

1. The channel has to be in the YouTube Partner Program.
2. Once it is, set **YouTube Studio → Settings → Upload defaults → Monetization** to
   ads-on, and every API upload inherits it.

Two things the bot does control, both of which quietly kill monetization if wrong:

- `selfDeclaredMadeForKids` is set to `false` on every upload. Made-for-kids videos get
  no personalized ads.
- If the *channel* is flagged made-for-kids, nothing overrides that. `npm run doctor`
  warns when it sees this.

## Gotchas worth knowing

- **Unverified Google Cloud projects can only upload private videos.** The API accepts
  `privacyStatus: "public"` and locks the video as private anyway, and `/reel publish`
  comes back 403 Forbidden. Until the project passes API verification, publishing is a
  YouTube Studio action. The default `YOUTUBE_PRIVACY=private` matches this reality.
- **Docker Compose parses `.env` more strictly than dotenv.** A stray line that is not
  `KEY=value`, a comment, or blank makes `docker compose` refuse the whole file with
  `key cannot contain a space`. Keep escape sequences out of comments.
- **`#` in a .env value starts a comment.** dotenv drops everything after an unquoted
  `#`, so `YOUTUBE_TITLE_TEMPLATE=... #{n} ...` silently loses the episode number and
  `THUMBNAIL_ACCENT=#E62117` becomes empty. Wrap values containing `#` in double
  quotes, or use `0xRRGGBB` for colours. `npm run doctor` prints the resolved title so
  you can see it happen.
- **Videos over 15 minutes need a verified channel.** 20 clips at the 60s cap is a
  20-minute reel. `npm run doctor` checks `longUploadsStatus` and fails if your
  threshold and clip cap can exceed the limit.
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

## Resource use

The stitch step dominates everything else. Measured peak RSS for one ffmpeg call, by
resolution and number of inputs held open at once:

| Inputs | 1080p   | 720p   |
| ------ | ------- | ------ |
| 3      | 1030 MB | 495 MB |
| 4      | 1200 MB | 615 MB |
| 5      | 1450 MB | 705 MB |

Each extra input costs roughly 215 MB at 1080p, because every one keeps its own
decoder and frame buffers alive for the whole call. Joining 20 clips in a single
invocation would need about 4.5 GB and get OOM-killed on an 8 GB host.

So clips are folded `STITCH_BATCH` at a time into a tree: 20 clips at batch 4 become
5 segments, then 2, then 1. Peak memory is set by the batch size instead of the reel
length, at the cost of one extra encode pass per level. Intermediate levels encode at
CRF 16 rather than `X264_CRF`, so three or four compounding passes do not visibly
soften the final video.

Other limits worth knowing:

- `FFMPEG_THREADS` caps ffmpeg's threading. It barely affects memory (about 4%) but it
  is what stops encoding from saturating every core.
- `INGEST_CONCURRENCY` bounds simultaneous downloads. 1 on a small host.
- `MIN_FREE_DISK_MB` refuses to start a download when the volume is nearly full,
  rather than filling the disk and taking the host down with it.
- `MAX_DOWNLOAD_BYTES` defaults to 200 MB per clip.

Dropping to 720p (`OUTPUT_WIDTH=1280`, `OUTPUT_HEIGHT=720`) roughly halves both peak
memory and encode time.

## What this costs

Nothing. The YouTube Data API v3 is free and does not require a billing account on the
Google Cloud project — leave billing off and it stays off.

The only limit is quota, and quota is not purchasable. Every project gets 10,000 units
a day:

| Call                          | Units |
| ----------------------------- | ----- |
| `videos.insert` (one upload)  | 1600  |
| `thumbnails.set`              | 50    |
| `videos.update` (publish)     | 50    |
| `channels.list` (doctor)      | 1     |

So six uploads a day is the ceiling, and a normal week — one reel, one thumbnail — uses
about 1650 of the 10,000. Nowhere near it.

If you exceed the quota, uploads fail with `quotaExceeded` until the daily reset; you
are never charged. `BACKFILL_MAX_REELS` exists to stop a history drain before it gets
there. More quota is requested through Google's audit form, not by paying.

Keep the project free by enabling only *YouTube Data API v3*. Other Google Cloud APIs
can be billable; this one is not.

## Deploying with Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` is sized for a small host: a 1536 MB limit against a measured
~1.2 GB peak at 1080p with `STITCH_BATCH=3`, 2 CPUs, and `cpu_shares` set low so a
long encode yields to anything else on the box. A commented 720p block halves it.

The image is Debian-based rather than Alpine on purpose — `better-sqlite3` and
`ffmpeg-static` both ship glibc binaries, and musl would mean compiling both from
source. It also installs `fonts-dejavu-core` (drawtext needs a real TTF for the
thumbnail) and the `yt-dlp` binary.

State lives in the named volume `clipreel-data`: the SQLite database, downloaded clips,
and finished reels. **That volume is the only state — back it up.** Losing it means
losing the dedupe history and the episode numbering.

```bash
docker run --rm -v clipreel_clipreel-data:/data -v "$PWD:/backup" alpine tar czf /backup/clipreel-data.tar.gz -C /data .
```

A named volume rather than a host bind mount, because of file ownership. The container
runs unprivileged as uid 1000, but a bind-mounted host directory arrives owned by root
— the mount replaces whatever the image set — and the app dies at startup:

```
Error: EACCES: permission denied, mkdir '/app/data/raw'
```

Docker seeds a *named* volume from the image instead, ownership included, so there is
nothing to fix. If you would rather use a host directory, swap the volume line for
`- ./data:/app/data`; the entrypoint starts as root only long enough to take ownership
of the data directory, then drops to uid 1000 before running the bot, so that works
too. Set `APP_UID`/`APP_GID` if the host directory belongs to someone other than 1000.

If you already have data in a host `./data` from an earlier deploy and want to move to
the named volume, copy it across before switching:

```bash
docker run --rm -v "$PWD/data:/from" -v clipreel_clipreel-data:/to alpine cp -a /from/. /to/
```

A healthcheck watches a heartbeat file that is only refreshed while the Discord
gateway is connected, so a wedged websocket is restarted instead of sitting there
looking alive.

### Dokploy

The bot is a worker, not a web app, but it serves `GET /health` on port 3000 so the
platform has something to route and poll.

1. **Application → Create → Docker Compose**, pointed at this repository.
2. **Environment** tab: paste the contents of your `.env` there. Dokploy writes it to a
   `.env` beside the compose file, which is what `env_file:` picks up. Do not commit
   `.env` to the repo — it is in `.gitignore` and `.dockerignore` for that reason, and
   the image never contains it.
3. **Domains** tab: add `bot.mohammadalsmadi.com` pointing at port **3000**, and delete
   the `ports:` block from `docker-compose.yml` — Dokploy's proxy reaches the container
   directly, so publishing on the host only risks a port conflict.
4. Deploy. Then check `https://bot.mohammadalsmadi.com/health`.

`/health` returns 200 while the Discord gateway is connected and 503 when it is not, so
it doubles as an uptime check. It exposes only status counters — no clip URLs, no member
names, no configuration. Set `HTTP_PORT=0` to turn it off entirely if you would rather
not have it public.

**The OAuth redirect URI does not change.** It is used only by the one-time consent
flow; the running bot authenticates with the refresh token and never receives a
redirect. Run `npm run youtube:auth` **on your laptop**, keep
`http://localhost:8787/oauth2callback` registered in Google Cloud, and paste the
resulting `YOUTUBE_REFRESH_TOKEN` into Dokploy's Environment tab. Adding
`bot.mohammadalsmadi.com` as a redirect URI would do nothing.

Run the one-off commands against the running container:

```bash
docker compose exec clipreel node dist/scripts/doctor.js
```

```bash
docker compose exec clipreel node dist/scripts/backfill.js
```

On Dokploy use the **Terminal** tab on the application, which drops you into the same
container.

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
| `YOUTUBE_AUTO_PUBLISH`| `false`             | `true` uploads straight at `YOUTUBE_PRIVACY`   |
| `TITLE_CARDS`         | `false`             | `true` burns `@author` over each clip          |
| `THUMBNAIL_LABEL`     | `GAMING CLIPS`      | Text across the thumbnail band                 |
| `THUMBNAIL_ACCENT`    | `0xE62117`          | Badge and rule colour — `0x`, never `#`        |
| `X264_PRESET`         | `veryfast`          | `slow` for smaller files, much longer compiles |
| `STITCH_BATCH`        | `4`                 | Memory dial — see Resource use                 |
| `FFMPEG_THREADS`      | `0`                 | 0 = one thread per core                        |
| `INGEST_CONCURRENCY`  | `2`                 | Simultaneous downloads                         |
| `BACKFILL_MAX_REELS`  | `5`                 | Reels per backfill run, under the daily quota  |
| `MIN_FREE_DISK_MB`    | `2048`              | Ingest refuses to run below this               |
| `HTTP_PORT`           | `3000`              | `/health` endpoint; 0 disables it              |

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
  drain.ts           full-history backfill driven into 20-clip reels
  heartbeat.ts       liveness file behind the container healthcheck
  http.ts            GET /health status endpoint
scripts/
  youtube-auth.ts    one-time consent flow that prints the refresh token
  doctor.ts          checks every integration point, changes nothing
  backfill.ts        walk the whole channel and build reels from it
  run-now.ts         compile and upload immediately
  healthcheck.ts     container healthcheck entry point
```

State lives in `data/`: `clipreel.db`, downloaded clips in `raw/`, intermediates in
`work/`, finished reels in `out/`. Set `CLEANUP_SOURCES=true` to delete source clips
once their reel is uploaded.
