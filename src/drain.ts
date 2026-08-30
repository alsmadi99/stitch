import type { Client } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { countPending } from './db/clips.js';
import { pendingUploadCount } from './db/reels.js';
import { backfill, type BackfillStats } from './discord/collector.js';
import { DiskFullError } from './ingest/ingest.js';
import { runPipeline } from './pipeline.js';
import { isQuotaError } from './youtube/upload.js';

/** How often to re-check whether the compile that blocked us has finished. */
const BUSY_POLL_MS = 5000;

export type StopReason =
  | 'complete'
  | 'quota'
  | 'deferred'
  | 'pendingCap'
  | 'maxReels'
  | 'cancelled'
  | 'disk'
  | 'error';

export interface DrainResult extends BackfillStats {
  reels: number;
  stoppedBy: StopReason;
  detail?: string;
}

export interface DrainOptions {
  /** Messages to scan. Omit to walk the whole channel. */
  limit?: number;
  /** Rescan from the first message instead of resuming the saved cursor. */
  restart?: boolean;
  /** Cap on reels produced in this run. Defaults to BACKFILL_MAX_REELS. */
  maxReels?: number;
  /** Called after each page and each reel, so a caller can report live progress. */
  onProgress?: (progress: BackfillStats & { reels: number }) => void;
  /** Polled at checkpoints; returning true stops the scan cleanly. */
  shouldStop?: () => boolean;
}

/**
 * Walks the channel history and turns it into reels of at most REEL_MAX_CLIPS, one at
 * a time.
 *
 * The reel is built as soon as the queue is deep enough rather than after the whole
 * scan, which is what keeps disk use flat: roughly 20 clips are on disk at any moment
 * instead of the channel's entire video history.
 *
 * The run stops on its own at `maxReels`. YouTube allows 10,000 quota units a day and
 * an upload costs 1,600, so six uploads is the hard daily ceiling — going past it
 * fails every remaining upload rather than queueing them. Progress is checkpointed, so
 * tomorrow's run continues where this one stopped.
 */
export async function drainHistory(client: Client, options: DrainOptions = {}): Promise<DrainResult> {
  const maxReels = options.maxReels ?? config.ingest.backfillMaxReels;
  let reels = 0;
  let stoppedBy: StopReason = 'complete';
  let detail: string | undefined;

  const buildReel = async (): Promise<boolean> => {
    if (options.shouldStop?.()) {
      stoppedBy = 'cancelled';
      detail = 'stopped on request before building the next reel';
      return false;
    }

    if (reels >= maxReels) {
      stoppedBy = 'maxReels';
      detail = `reached the ${maxReels} reel cap for this run`;
      return false;
    }

    try {
      // `busy` means a compile is already under way — usually the live collector
      // reacting to a clip this scan just ingested. Carrying on regardless would keep
      // downloading while that reel builds, and the queue grows without bound: the
      // whole point of building at the threshold is to hold roughly one reel's worth of
      // clips on disk at a time. So wait for it, then take our turn.
      let result = await runPipeline('threshold');
      let waited = 0;

      while (result.status === 'busy') {
        if (options.shouldStop?.()) {
          stoppedBy = 'cancelled';
          detail = 'stopped on request while waiting for a compile to finish';
          return false;
        }

        await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
        waited += BUSY_POLL_MS;
        if (waited % 60_000 === 0) {
          logger.info({ waitedSeconds: waited / 1000 }, 'waiting for the current compile');
        }

        result = await runPipeline('threshold');
      }

      if (result.status === 'uploaded' || result.status === 'compiled') reels++;
      report();

      // A deferred upload is almost always the daily quota, which no amount of waiting
      // in this run will fix. Rather than stopping outright, keep building ahead — the
      // retry sweep uploads them as quota frees up — but only while the finished videos
      // waiting to go out stay within MAX_PENDING_UPLOADS, since each one sits on disk.
      if (result.status === 'deferred' && pendingUploadCount() >= config.ingest.maxPendingUploads) {
        stoppedBy = 'pendingCap';
        detail =
          `${pendingUploadCount()} built reels are waiting on the daily upload quota. ` +
          'They upload themselves as it resets, and the scan continues automatically once there is room';
        return false;
      }

      return true;
    } catch (err) {
      if (isQuotaError(err)) {
        stoppedBy = 'quota';
        detail = 'YouTube daily upload quota exhausted — run again tomorrow to continue';
        return false;
      }
      throw err;
    }
  };

  let stats: BackfillStats = { scanned: 0, accepted: 0, duplicate: 0, rejected: 0 };
  let lastStats: BackfillStats = stats;
  const report = () => options.onProgress?.({ ...lastStats, reels });

  try {
    stats = await backfill(client, {
      limit: options.limit,
      restart: options.restart,
      onThreshold: buildReel,
      shouldStop: options.shouldStop,
      onProgress: (s) => {
        lastStats = s;
        logger.info({ ...s, reels }, 'drain progress');
        report();
      },
    });

    // Whatever is left over after the scan is still worth a (shorter) reel.
    if (stoppedBy === 'complete' && countPending() > 0 && reels < maxReels) {
      const result = await runPipeline('manual');
      if (result.status === 'uploaded' || result.status === 'compiled') reels++;
      if (result.status === 'deferred') stoppedBy = 'deferred';
    }
  } catch (err) {
    if (err instanceof DiskFullError) {
      stoppedBy = 'disk';
      detail = err.message;
    } else if (isQuotaError(err)) {
      stoppedBy = 'quota';
      detail = 'YouTube daily upload quota exhausted — run again tomorrow to continue';
    } else {
      stoppedBy = 'error';
      detail = err instanceof Error ? err.message : String(err);
      logger.error({ err: detail }, 'drain failed');
    }
  }

  const result: DrainResult = { ...stats, reels, stoppedBy, detail };
  logger.info(result, 'drain finished');
  return result;
}

export function describeDrain(result: DrainResult): string {
  const lines = [
    `Scanned ${result.scanned} messages: ${result.accepted} clips queued, ${result.duplicate} duplicates, ${result.rejected} rejected.`,
    `Built ${result.reels} reel${result.reels === 1 ? '' : 's'}.`,
  ];

  if (result.stoppedBy !== 'complete' && result.detail) {
    lines.push(`Stopped: ${result.detail}`);
    lines.push('Progress is saved — running the command again picks up from here.');
  } else {
    lines.push(`${countPending()} clips still queued.`);
  }

  return lines.join('\n');
}
