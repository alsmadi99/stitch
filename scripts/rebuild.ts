/**
 * Rebuilds a reel that has already been compiled once — after an encoder change, a
 * pipeline fix, or a batch that came out wrong.
 *
 * The clip table records which clips went into which reel, so a rebuild is exact: the
 * same clips, in the same order, under the same episode number. What it cannot assume is
 * that the source files are still on disk. `CLEANUP_SOURCES=true` deletes them once the
 * upload succeeds, so anything missing is re-fetched from Discord first.
 *
 * Discord's attachment URLs are signed and expire, so the stored `source_url` is no use
 * for a re-fetch. The message id is, and the current URL is read back from the API.
 *
 * YouTube cannot replace a video's file — an upload is bound to its id for life. So
 * `--upload` always produces a NEW link, and the old video is left alone unless
 * `--replace-youtube` is passed as well.
 *
 * `--reel` takes a database row id. That is NOT the episode number: a reel that failed
 * still consumes an id but is never counted towards the episode, so the two drift apart
 * as soon as anything goes wrong. Use `--episode` to name the video by the `#N` in its
 * title, which is what YouTube shows.
 *
 *   npm run rebuild -- --episode 8              what it would do, changing nothing
 *   npm run rebuild -- --last                   same, for the most recent reel
 *   npm run rebuild -- --episode 8 --yes        re-fetch what is missing, recompile
 *   npm run rebuild -- --episode 8 --yes --refetch   download the clips again too
 *   npm run rebuild -- --episode 8 --yes --upload --private
 *                                               ... and upload it privately for review
 *   npm run rebuild -- --episode 8 --yes --upload --private --replace-youtube
 *                                               ... and delete the old video afterwards
 *
 * Add `--detach` to any of these to run it in the background and return immediately.
 * The command prints a log file to tail; the terminal can then be closed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { clipsForReel, updateClip } from '../src/db/clips.js';
import { completedReelCount, findByEpisode, getReel, latestReel, updateReel } from '../src/db/reels.js';
import { acquireCompileLock, releaseCompileLock } from '../src/pipeline.js';
import { compileReel } from '../src/video/compile.js';
import { downloadDirect, downloadViaYtDlp } from '../src/ingest/download.js';
import { probe } from '../src/ingest/probe.js';
import { buildDescription, buildTags, buildTitle } from '../src/youtube/metadata.js';
import { uploadPrivacy, uploadReel } from '../src/youtube/upload.js';
import { addReelToPlaylist } from '../src/youtube/playlist.js';
import { youtubeClient } from '../src/youtube/auth.js';
import type { ClipRow } from '../src/types.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const confirmed = flag('yes');
const wantUpload = flag('upload');
const replaceYoutube = flag('replace-youtube');
const refetch = flag('refetch');
const private_ = flag('private');
const detach = flag('detach');

/**
 * Re-launches this script detached, so the work outlives the shell that started it.
 *
 * A hosting panel's web terminal closes its pty when the session times out, which hangs
 * up every process in that session's group — a rebuild that is twenty minutes into an
 * encode dies with it. `detached` puts the child in a session of its own, and the log
 * file stands in for a stdout that is about to disappear.
 */
if (detach && !process.env.STITCH_DETACHED) {
  const slug = option('episode') ?? option('reel') ?? (flag('last') ? 'last' : 'reel');
  const logFile = path.join(config.paths.dataDir, `rebuild-${slug}-${Date.now()}.log`);
  const handle = fs.openSync(logFile, 'a');

  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1]!, ...argv.filter((a) => a !== '--detach')],
    {
      detached: true,
      stdio: ['ignore', handle, handle],
      env: { ...process.env, STITCH_DETACHED: '1' },
    },
  );
  child.unref();

  console.log('');
  console.log(`rebuild running in the background, pid ${child.pid}`);
  console.log(`  watch:  tail -f ${logFile}`);
  console.log(`  check:  tail -30 ${logFile}`);
  console.log('');
  console.log('Safe to close this terminal.');
  process.exit(0);
}

function target(): ReturnType<typeof getReel> {
  if (flag('last')) return latestReel();

  // Preferred, because it is the number on the video. `--reel` stays for the cases
  // `--episode` cannot reach: a reel that failed before it was ever given a title.
  const episode = Number(option('episode'));
  if (Number.isFinite(episode)) {
    const matches = findByEpisode(episode);
    if (matches.length > 1) {
      console.error(`Episode #${episode} matches ${matches.length} reels: ${matches.map((r) => `#${r.id}`).join(', ')}.`);
      console.error('Pick one with --reel <id>.');
      process.exit(1);
    }
    return matches[0];
  }

  const id = Number(option('reel'));
  if (!Number.isFinite(id)) {
    console.error('Which reel? Pass --episode <n> (the number in the title), --reel <id>, or --last.');
    process.exit(1);
  }
  return getReel(id);
}

const reel = target();
if (!reel) {
  console.error('No such reel.');
  process.exit(1);
}

// Held, not merely checked: the bot can start a reel of its own in the gap between a
// check and the compile, and two ffmpeg runs on this host is an OOM kill.
if (!acquireCompileLock()) {
  console.error('A compile is already running. Wait for it to finish, or stop the bot first.');
  process.exit(1);
}
// Every exit path below goes through here, including the process.exit calls.
process.on('exit', releaseCompileLock);

const clips = clipsForReel(reel.id);
if (clips.length === 0) {
  console.error(
    `Reel #${reel.id} has no clips attached. A failed reel releases its clips back to the ` +
      `queue and a backfill --restart wipes the link, so there is nothing to rebuild from.`,
  );
  process.exit(1);
}

/**
 * The episode number, taken from the title the reel was uploaded under.
 *
 * Recomputing it from the reel count would renumber the episode whenever other reels have
 * uploaded since, which is the drift the stored title exists to prevent.
 */
const sequence = Number(reel.title?.match(/#(\d+)/)?.[1]) || completedReelCount() + 1;

const missing = clips.filter((c) => !c.file_path || !fs.existsSync(c.file_path));
const onDisk = clips.length - missing.length;

// Both numbers, always: they are not the same thing, and confusing them rebuilds
// the wrong video.
console.log(`\nreel id ${reel.id}  ${reel.status}  episode #${sequence}`);
console.log(`  title      ${reel.title ?? '(none)'}`);
console.log(`  youtube    ${reel.youtube_url ?? '(not uploaded)'}`);
console.log(`  clips      ${clips.length}  (${onDisk} on disk, ${missing.length} to download)`);
console.log(`  video      ${reel.video_path ?? '(none)'}`);

if (!confirmed) {
  console.log('\nDry run. Nothing changed. Add --yes to rebuild.');
  if (wantUpload) {
    console.log(`With --yes it would also upload the result as a NEW video (${private_ ? 'private' : uploadPrivacy()}).`);
  }
  if (replaceYoutube) console.log(`It would then DELETE ${reel.youtube_url}.`);
  process.exit(0);
}

if (replaceYoutube && !wantUpload) {
  console.error(
    '--replace-youtube only makes sense with --upload. Refusing to delete a video without a replacement.',
  );
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.discord.token);

interface DiscordMessage {
  attachments: { url: string; filename: string }[];
}

/**
 * Puts a clip's file back on disk.
 *
 * The stored URL is only usable for links; a Discord attachment needs a freshly signed
 * one, which means reading the message again. If the message has since been deleted the
 * clip is unrecoverable, and that is reported rather than quietly skipped — a reel
 * rebuilt from nineteen of its twenty clips is not the same reel.
 */
async function refetchClip(clip: ClipRow): Promise<string> {
  const destBase = path.join(config.paths.rawDir, `clip-${clip.id}`);

  if (clip.source_type === 'link') return downloadViaYtDlp(clip.source_url, destBase);

  const message = (await rest.get(
    Routes.channelMessage(clip.channel_id, clip.message_id),
  )) as DiscordMessage;

  const wanted = path.basename(new URL(clip.source_url).pathname);
  const attachment = message.attachments.find((a) => a.filename === wanted) ?? message.attachments[0];
  if (!attachment) throw new Error('the message no longer carries an attachment');

  return downloadDirect(attachment.url, destBase);
}

let restored = 0;
for (const clip of clips) {
  const present = clip.file_path !== null && fs.existsSync(clip.file_path);
  if (present && !refetch) continue;

  try {
    const file = await refetchClip(clip);
    const meta = await probe(file);
    updateClip(clip.id, {
      file_path: file,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
    });
    clip.file_path = file;
    restored++;
    console.log(`  fetched clip ${clip.id} (${path.basename(file)})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nCould not recover clip ${clip.id} from message ${clip.message_id}: ${message}`);
    console.error('Rebuilding without it would produce a different reel. Stopping.');
    process.exit(1);
  }
}
if (restored > 0) console.log(`  ${restored} clip(s) restored`);

// Removed only now, once every clip is accounted for, so a failed re-fetch above leaves
// the existing video intact rather than destroying it on the way to an error.
for (const stale of [reel.video_path, reel.thumbnail_path]) {
  if (stale !== null && fs.existsSync(stale)) {
    await fsp.rm(stale, { force: true });
    console.log(`  removed ${path.basename(stale)}`);
  }
}

console.log('\ncompiling...');
const compiled = await compileReel(reel.id, clips, sequence);
const out = await probe(compiled.videoPath);

updateReel(reel.id, {
  status: 'ready',
  video_path: compiled.videoPath,
  thumbnail_path: compiled.thumbnailPath,
  error: null,
});

console.log(
  `\nrebuilt: ${compiled.videoPath}  ${out.videoDuration.toFixed(1)}s  ${out.width}x${out.height}`,
);

if (!wantUpload) {
  console.log('Not uploaded. Watch it, then add --upload when you are happy with it.');
  process.exit(0);
}

if (!config.youtube.enabled) {
  console.error('YouTube is not configured — the rebuilt video is on disk, but cannot be uploaded.');
  process.exit(1);
}

const previousId = reel.youtube_id;
const title = reel.title ?? buildTitle(sequence, clips.length);
const description = reel.description ?? buildDescription(sequence, title);

const result = await uploadReel({
  videoPath: compiled.videoPath,
  thumbnailPath: compiled.thumbnailPath,
  title,
  description,
  tags: buildTags(),
  ...(private_ ? { privacy: 'private' as const } : {}),
});

updateReel(reel.id, {
  status: 'uploaded',
  youtube_id: result.videoId,
  youtube_url: result.url,
  // The old playlist entry points at the old video, so this reel needs a fresh one.
  playlist_item_id: null,
  published_at: new Date().toISOString(),
});
await addReelToPlaylist(reel.id, result.videoId);

console.log(`\nuploaded: ${result.url}  (${result.privacy})`);
logger.info({ reelId: reel.id, youtube: result.url }, 'reel rebuilt');

if (!replaceYoutube) {
  if (previousId) console.log(`The previous video is still up: https://youtu.be/${previousId}`);
  process.exit(0);
}

if (!previousId) {
  console.log('No previous video on record to delete.');
  process.exit(0);
}

// Last, and only after the replacement is safely up: this cannot be undone.
await youtubeClient().videos.delete({ id: previousId });
console.log(`deleted the previous video: https://youtu.be/${previousId}`);

process.exit(0);
