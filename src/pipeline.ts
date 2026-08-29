import fsp from 'node:fs/promises';
import { config } from './config.js';
import { logger } from './logger.js';
import * as clipsRepo from './db/clips.js';
import * as reelsRepo from './db/reels.js';
import { compileReel } from './video/compile.js';
import { buildDescription, buildTitle } from './youtube/metadata.js';
import { uploadReel } from './youtube/upload.js';
import { announceFailure, announceReel } from './discord/notify.js';

export type Trigger = 'threshold' | 'cron' | 'manual';

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
    const compiled = await compileReel(reelId, batch);

    const title = buildTitle(reelsRepo.publishedReelCount() + 1, batch.length);
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

    const description = buildDescription(
      compiled.chapters,
      compiled.duration,
      clipsRepo.contributorsForReel(reelId),
    );

    const upload = await uploadReel({
      videoPath: compiled.videoPath,
      thumbnailPath: compiled.thumbnailPath,
      title,
      description,
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
