import fsp from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import * as clipsRepo from './db/clips.js';
import * as reelsRepo from './db/reels.js';
import { compileReel } from './video/compile.js';
import { buildDescription, buildTags, buildTitle } from './youtube/metadata.js';
import { uploadReel } from './youtube/upload.js';
import { announceFailure, announceReel } from './discord/notify.js';

export type Trigger = 'threshold' | 'cron' | 'manual';

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
  status: 'skipped' | 'busy' | 'compiled' | 'uploaded';
  reelId?: number;
  reason?: string;
  youtubeUrl?: string;
}

// Compiling is CPU-bound and writes to shared work directories, so only one run at a
// time — a threshold trigger firing during the weekly run must not start a second.
let running = false;

export function isRunning(): boolean {
  return running;
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

    reelsRepo.setReelStatus(reelId, 'uploading');

    const upload = await uploadReel({
      videoPath: compiled.videoPath,
      thumbnailPath: compiled.thumbnailPath,
      title,
      description: buildDescription(sequence, title),
      tags: buildTags(),
    });

    reelsRepo.updateReel(reelId, {
      status: config.youtube.autoPublish ? 'published' : 'uploaded',
      youtube_id: upload.videoId,
      youtube_url: upload.url,
      published_at: config.youtube.autoPublish ? new Date().toISOString() : null,
    });

    await announceReel(reelId, {
      title,
      duration: compiled.duration,
      clipCount: batch.length,
      youtubeUrl: upload.url,
      privacy: upload.privacy,
    });

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
  }
}

async function removeSources(paths: (string | null)[]): Promise<void> {
  await Promise.all(
    paths.filter((p): p is string => Boolean(p)).map((p) => fsp.rm(p, { force: true }).catch(() => undefined)),
  );
}
