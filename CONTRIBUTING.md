# Contributing to Stitch

Thanks for looking. This is a small project with an unusually fiddly middle — most of
the surprises live in ffmpeg, YouTube's quota, and Discord's gateway, not in the
TypeScript. This document is mostly about those.

## Getting set up

```bash
npm install
cp .env.example .env
npm run doctor
```

You do not need YouTube credentials to work on most of it. Leave the `YOUTUBE_*`
variables blank and the bot runs in local-only mode: reels are compiled to `data/out/`
and nothing is uploaded. That is the fastest loop for anything touching the video
pipeline.

You do need a Discord bot token and a test server. Make a private one — it takes two
minutes and means you are not experimenting in a channel other people can see.

```bash
npm run dev        # watch mode
npm run typecheck
npm run lint
npm run build
```

## Before you open a pull request

```bash
npm run typecheck && npm run lint
```

Both must pass. `strict` is on and stays on, including `noUncheckedIndexedAccess` —
if the compiler is making you write `!`, it is usually pointing at a real case you have
not thought about yet.

Keep the diff to one thing. A PR that fixes a bug *and* reformats a file is two PRs.

## If you touch the video pipeline, measure it

This is the one hard rule, and it exists because every bug this project has had in
`src/video/` was invisible by inspection and obvious under measurement.

Some real examples from its history:

- Audio drifted **323ms** ahead of picture by the end of a reel. Every individual filter
  looked correct. It only showed up when clips were built carrying a white flash and a
  1kHz beep at the same instant, and `blackdetect` was compared against `silencedetect`.
- A clip froze on its last frame for **800ms**. The cause was reading the container
  duration instead of the video stream duration, which differ whenever a screen recorder
  writes audio slightly longer than video.
- A tree level with a leftover batch of exactly one deleted the file the next level was
  about to read. It only reproduced at specific clip counts.

Start with the one that already exists:

```bash
npm run verify
```

It builds a reel from deliberately awkward clips and asserts every one appears in its own
slot, fully and exactly once. If your change breaks the pipeline, this is the cheapest
way to find out.

Beyond that, if you change normalize, stitch, or anything touching durations and offsets,
include the measurement in the PR. Concretely, one of these:

- **Sync** — build clips with a simultaneous flash and beep, compile, and compare
  `blackdetect` output against `silencedetect`.
- **Duration** — assert the output is `sum(durations) - (N-1) * transition`.
- **Freezing** — run `freezedetect` over the result and expect zero segments.
- **Memory** — sample peak RSS of the ffmpeg process if you change how many inputs are
  held open at once.
- **Awkward inputs** — variable frame rate, timestamps that do not start at zero, audio
  longer than video. `npm run verify` already covers these; extend it rather than
  testing by hand.

"It looked fine when I watched it" is not a measurement. A 300ms drift is inaudible in
the first ten seconds.

## Things that are the way they are on purpose

Before changing these, know why they exist:

- **Backfill is not a Discord command.** It downloads gigabytes and spends a day's
  upload quota. A chat command is the wrong trigger regardless of who may send it.
- **Uploads are private unless `YOUTUBE_AUTO_PUBLISH=true`.** Publishing is a decision,
  and this setting used to be advisory, which surprised somebody with a public channel.
- **Clips are marked `used` before compiling, and released on startup if the process
  died.** Without that recovery, a redeploy mid-compile orphans twenty clips forever.
- **Vetoed clips get their own status, not `rejected`.** Reel failure returns `used`
  rows to the queue; a vetoed clip must not come back, and a distinct status is what
  makes that fall out naturally rather than needing a special case.
- **Reels are assembled from bodies and half-second transitions, not joined whole.**
  The obvious approach — hand `xfade` two long segments and blend at the end — buffered
  roughly the whole crossfade offset as decoded frames and was OOM-killed at 3 GB. No
  batching scheme avoided it, because the offset grows with the reel. Keep every ffmpeg
  call bounded to one clip or two half-second inputs.
- **Bodies are re-encoded rather than stream-copied.** A copy is far cheaper but can only
  cut on a keyframe, which put the soundtrack four seconds out over twenty clips.

If you disagree with one, say so in an issue first — these are opinions with reasons,
and reasons can be wrong, but rediscovering them through an outage is expensive.

## Reporting a bug

Include:

- What you expected and what happened.
- The relevant log lines. The bot logs JSON; the `msg` and `err` fields are the useful
  ones. **Redact your tokens** — `DISCORD_TOKEN` and `YOUTUBE_REFRESH_TOKEN` grant full
  control of your bot and channel.
- `npm run doctor` output, which reports versions and configuration without secrets.
- For video problems: clip count, resolution, and the output of `npm run verify`. Sample
  footage helps enormously if you can share it — most pipeline bugs here only appeared
  with real capture output.

## Style

Prettier and ESLint decide formatting; do not argue with them in review.

Comments should explain *why*, not *what*. The codebase leans on this — most comments in
`src/video/` exist to record a measurement or a constraint that is not visible from the
code, and those are the comments worth writing.

## Security

Do not open a public issue for a security problem. Email the maintainer instead.

Never commit `.env`. It is gitignored, along with `.env.*` variants, because the most
common way these tokens leak is a `.env.backup` created on a server during debugging.

## License

Contributions are accepted under the MIT license that covers the project.
