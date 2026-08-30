import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import * as clipsRepo from './db/clips.js';
import * as reelsRepo from './db/reels.js';
import { compileReel } from './video/compile.js';
import { buildDescription, buildTags, buildTitle } from './youtube/metadata.js';
import { isQuotaError, isRetryableUploadError, uploadReel, type UploadResult } from './youtube/upload.js';
import { announceFailure, announceReel } from './discord/notify.js';

export type Trigger = 'threshold' | 'cron' | 'manual';

/**
 * How long to wait before trying an upload again.
 *
 * YouTube's quota resets once a day, so there is no point retrying a quota failure in
 * minutes — six hours is frequent enough to pick up the reset without hammering the
 * API. Transient failures back off exponentially from five minutes.
 */
const QUOTA_RETRY_MS = 6 * 60 * 60_000;
const TRANSIENT_BASE_MS = 5 * 60_000;
const TRANSIENT_MAX_MS = 2 * 60 * 60_000;

/**
 * After this many failures the reel is abandoned: its clips go back in the queue and
 * the video is deleted. Twelve attempts at six-hourly quota backoff is three days, well
 * past any daily reset or outage that was going to resolve itself.
 */
const MAX_UPLOAD_ATTEMPTS = 12;

/**
 * Returns clips from reels that never finished.
 *
 * Clips are marked `used` before compiling starts, and compiling takes minutes. If the
 * process is killed in that window — a redeploy, an OOM, a host reboot — the failure
 * handler never runs and those clips stay attached to a reel stuck in `building`,
 * silently excluded from every future reel. Recovering at startup is the only place
 * this can be caught, because by definition the process that owned them is gone.
 *
 * A reel interrupted during `uploading` is treated the same way. The window between
 * YouTube returning a video id and that id being written to the database is a few
 * milliseconds, so a duplicate upload is vanishingly unlikely — and losing 20 clips is
 * the worse outcome.
 */
export function recoverInterruptedReels(): number {
  const stuck = reelsRepo.unfinishedReels();
  if (stuck.length === 0) return 0;

  for (const reel of stuck) {
    // A reel interrupted while uploading already has a finished video on disk. Throwing
    // it away would mean re-encoding twenty clips to fix an interrupted transfer, so it
    // rejoins the retry queue instead.
    if (reel.status === 'uploading' && reel.video_path && fs.existsSync(reel.video_path)) {
      reelsRepo.updateReel(reel.id, {
        status: 'pending_upload',
        next_attempt_at: null,
        error: 'interrupted during upload',
      });
      logger.warn({ reelId: reel.id }, 'requeued an interrupted upload');
      continue;
    }

    clipsRepo.releaseClips(reel.id);
    reelsRepo.setReelStatus(reel.id, 'failed', 'interrupted before it finished');
    logger.warn(
      { reelId: reel.id, status: reel.status, clips: reel.clip_count },
      'recovered clips from an interrupted reel',
    );
  }

  return stuck.length;
}

export interface RunResult {
  /** `deferred` means the video is built and queued for a later upload attempt. */
  status: 'skipped' | 'busy' | 'compiled' | 'deferred' | 'uploaded';
  reelId?: number;
  reason?: string;
  youtubeUrl?: string;
}

// Compiling is CPU-bound and writes to shared work directories, so only one run at a
// time — a threshold trigger firing during the weekly run must not start a second.
let running = false;

const LOCK_FILE = path.join(config.paths.dataDir, 'compile.lock');

/**
 * Identifies this run of this process, not just its pid.
 *
 * A pid alone is useless as a liveness check inside a container, where the bot is
 * always pid 1: a lock left behind by a killed process names pid 1, the next boot is
 * also pid 1, and "is the holder alive?" answers yes forever. That deadlocks compiling
 * permanently — every trigger is skipped and clips queue up with nothing consuming them.
 */
const INSTANCE = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

interface LockHolder {
  pid: number;
  instance: string;
  since: string;
}

function readLock(): LockHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.instance !== 'string') return null;
    return { pid: parsed.pid, instance: parsed.instance, since: parsed.since ?? '' };
  } catch {
    return null;
  }
}

/** Only a lock this very process wrote can be treated as genuinely held. */
function heldByAnother(holder: LockHolder): boolean {
  if (holder.instance === INSTANCE) return false;
  return isAlive(holder.pid);
}

/**
 * Clears a lock left over from a previous life of this container.
 *
 * Called once at startup, where nothing can legitimately be compiling: any process that
 * held the lock died with the container that hosted it.
 */
export function clearStaleLock(): void {
  const holder = readLock();
  if (!holder) {
    fs.rmSync(LOCK_FILE, { force: true });
    return;
  }
  logger.warn({ heldSince: holder.since, pid: holder.pid }, 'cleared a stale compile lock');
  fs.rmSync(LOCK_FILE, { force: true });
}

/** True when *this* process is compiling. */
export function isRunning(): boolean {
  return running;
}

/**
 * True when any process on this data volume is compiling — this one, the bot, or a
 * backfill started from a shell. Status readouts have to use this rather than the
 * in-process flag, or the bot cheerfully reports "idle" while a backfill it cannot see
 * is pinning both cores.
 */
export function isCompilingAnywhere(): boolean {
  if (running) return true;
  const holder = readLock();
  return holder ? heldByAnother(holder) : false;
}

/**
 * Cross-process guard on top of the in-process flag.
 *
 * The bot and a manually started backfill are separate processes sharing one data
 * volume, so the boolean above cannot see the other one. Two concurrent compiles would
 * double peak memory on a host sized for exactly one, and race to upload reels built
 * from overlapping clips.
 *
 * A lock left behind by a killed process is taken over once its pid is gone.
 */
function acquireLock(): boolean {
  const payload = JSON.stringify({ pid: process.pid, instance: INSTANCE, since: new Date().toISOString() });

  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch {
    const holder = readLock();

    if (holder && heldByAnother(holder)) {
      logger.warn({ holder: holder.pid, since: holder.since }, 'another process is compiling — skipping');
      return false;
    }

    logger.warn({ holder: holder?.pid ?? null }, 'took over a stale compile lock');
    fs.writeFileSync(LOCK_FILE, payload);
    return true;
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseLock(): void {
  try {
    fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // Nothing useful to do; a stale lock is taken over on the next run.
  }
}

export async function runPipeline(trigger: Trigger): Promise<RunResult> {
  if (running) {
    logger.warn({ trigger }, 'pipeline already running');
    return { status: 'busy' };
  }

  const pending = clipsRepo.countPending();
  const floor = trigger === 'manual' ? 1 : trigger === 'cron' ? config.trigger.minClips : config.trigger.maxClips;

  if (pending < floor) {
    return { status: 'skipped', reason: `${pending} clips pending, need ${floor}` };
  }

  if (!acquireLock()) return { status: 'busy' };

  running = true;
  const batch = clipsRepo.takePending(config.trigger.maxClips);
  const reelId = reelsRepo.createReel(batch.length);
  const log = logger.child({ reelId, trigger });

  clipsRepo.markUsed(
    batch.map((c) => c.id),
    reelId,
  );

  try {
    log.info({ clips: batch.length }, 'pipeline start');

    // The episode number is burned into the thumbnail as well as the title, so it has
    // to be settled before compiling rather than at upload time.
    const sequence = reelsRepo.completedReelCount() + 1;
    const compiled = await compileReel(reelId, batch, sequence);

    const title = buildTitle(sequence, batch.length);
    reelsRepo.updateReel(reelId, {
      status: 'ready',
      video_path: compiled.videoPath,
      thumbnail_path: compiled.thumbnailPath,
      title,
    });

    if (!config.youtube.enabled) {
      log.warn('YouTube credentials missing — reel compiled but not uploaded');
      await announceReel(reelId, { title, duration: compiled.duration, clipCount: batch.length });
      return { status: 'compiled', reelId };
    }

    // The description is stored rather than rebuilt on retry: it names the episode
    // number, which must not drift if other reels upload in the meantime.
    reelsRepo.updateReel(reelId, { description: buildDescription(sequence, title) });

    const upload = await attemptUpload(reelId);
    if (!upload) {
      // Retryable failure. The video is on disk and the clips stay attached to it;
      // the retry worker takes it from here.
      log.warn('upload deferred — will retry automatically');
      return { status: 'deferred', reelId };
    }

    if (config.cleanupSources) await removeSources(batch.map((c) => c.file_path));

    log.info({ url: upload.url }, 'pipeline done');
    return { status: 'uploaded', reelId, youtubeUrl: upload.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message }, 'pipeline failed');
    // Put the clips back so the next run picks them up instead of losing a week of uploads.
    clipsRepo.releaseClips(reelId);
    reelsRepo.setReelStatus(reelId, 'failed', message);
    await announceFailure(reelId, message).catch(() => undefined);
    throw err;
  } finally {
    running = false;
    releaseLock();
  }
}

/**
 * Uploads a built reel, or schedules another attempt.
 *
 * Returns the upload on success and null when it failed in a way worth retrying. A
 * permanent rejection throws, because that is a real failure the caller should surface.
 *
 * Separating this from compiling is the whole point: a quota error has nothing to do
 * with the video, and re-encoding twenty clips because YouTube said "not today" wastes
 * roughly forty minutes of CPU for nothing.
 */
async function attemptUpload(reelId: number): Promise<UploadResult | null> {
  const reel = reelsRepo.getReel(reelId);
  if (!reel) throw new Error(`reel ${reelId} disappeared`);
  if (!reel.video_path || !fs.existsSync(reel.video_path)) {
    throw new Error(`reel ${reelId} has no video file to upload`);
  }

  const log = logger.child({ reelId, attempt: reel.upload_attempts + 1 });
  reelsRepo.setReelStatus(reelId, 'uploading');

  try {
    const upload = await uploadReel({
      videoPath: reel.video_path,
      thumbnailPath: reel.thumbnail_path ?? undefined,
      title: reel.title ?? `Reel #${reelId}`,
      description: reel.description ?? '',
      tags: buildTags(),
    });

    reelsRepo.updateReel(reelId, {
      status: config.youtube.autoPublish ? 'published' : 'uploaded',
      youtube_id: upload.videoId,
      youtube_url: upload.url,
      published_at: config.youtube.autoPublish ? new Date().toISOString() : null,
      next_attempt_at: null,
      error: null,
    });

    await announceReel(reelId, {
      title: reel.title ?? `Reel #${reelId}`,
      duration: 0,
      clipCount: reel.clip_count,
      youtubeUrl: upload.url,
      privacy: upload.privacy,
    });

    log.info({ url: upload.url }, 'upload succeeded');
    return upload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = reel.upload_attempts + 1;

    if (!isRetryableUploadError(err)) {
      reelsRepo.updateReel(reelId, { upload_attempts: attempts });
      throw err;
    }

    if (attempts >= MAX_UPLOAD_ATTEMPTS) {
      log.error({ err: message }, 'giving up on this reel after too many upload attempts');
      await abandonReel(reelId, `upload failed ${attempts} times: ${message}`);
      throw err;
    }

    const delay = isQuotaError(err)
      ? QUOTA_RETRY_MS
      : Math.min(TRANSIENT_BASE_MS * 2 ** (attempts - 1), TRANSIENT_MAX_MS);
    const nextAttempt = new Date(Date.now() + delay);

    reelsRepo.updateReel(reelId, {
      status: 'pending_upload',
      upload_attempts: attempts,
      next_attempt_at: nextAttempt.toISOString(),
      error: message,
    });

    log.warn(
      { err: message, retryInMinutes: Math.round(delay / 60_000), nextAttempt },
      'upload failed, scheduled a retry',
    );
    return null;
  }
}

/** Last resort: release the clips, drop the video, and stop trying. */
async function abandonReel(reelId: number, reason: string): Promise<void> {
  const reel = reelsRepo.getReel(reelId);
  clipsRepo.releaseClips(reelId);
  reelsRepo.setReelStatus(reelId, 'failed', reason);

  await Promise.all(
    [reel?.video_path, reel?.thumbnail_path]
      .filter((p): p is string => Boolean(p))
      .map((p) => fsp.rm(p, { force: true }).catch(() => undefined)),
  );

  await announceFailure(reelId, reason).catch(() => undefined);
}

/**
 * Retries every reel whose backoff has elapsed. Called at startup and on a timer, so a
 * quota exhaustion overnight resolves itself without anyone running a command.
 */
export async function retryPendingUploads(): Promise<number> {
  if (!config.youtube.enabled) return 0;

  const due = reelsRepo.dueForUpload(new Date().toISOString());
  if (due.length === 0) return 0;

  // Shares the compile lock so a retry cannot upload a reel a backfill is also handling.
  if (running || !acquireLock()) {
    logger.debug('skipping upload retries — busy');
    return 0;
  }

  running = true;
  let uploaded = 0;

  try {
    for (const reel of due) {
      logger.info({ reelId: reel.id, attempts: reel.upload_attempts }, 'retrying upload');
      try {
        if (await attemptUpload(reel.id)) uploaded++;
      } catch (err) {
        logger.error({ reelId: reel.id, err: (err as Error).message }, 'retry failed permanently');
      }
    }
  } finally {
    running = false;
    releaseLock();
  }

  return uploaded;
}

async function removeSources(paths: (string | null)[]): Promise<void> {
  await Promise.all(
    paths.filter((p): p is string => Boolean(p)).map((p) => fsp.rm(p, { force: true }).catch(() => undefined)),
  );
}
