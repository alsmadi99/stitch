import type { Client } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { countPending } from './db/clips.js';
import { backfill, type BackfillStats } from './discord/collector.js';
import { DiskFullError } from './ingest/ingest.js';
import { runPipeline } from './pipeline.js';
import { isQuotaError } from './youtube/upload.js';

export type StopReason = 'complete' | 'quota' | 'maxReels' | 'disk' | 'error';

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
    if (reels >= maxReels) {
      stoppedBy = 'maxReels';
      detail = `reached the ${maxReels} reel cap for this run`;
      return false;
    }

    try {
      const result = await runPipeline('threshold');
      if (result.status === 'uploaded' || result.status === 'compiled') reels++;
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

  try {
    stats = await backfill(client, {
      limit: options.limit,
      restart: options.restart,
      onThreshold: buildReel,
      onProgress: (s) => logger.info({ ...s, reels }, 'drain progress'),
    });

    // Whatever is left over after the scan is still worth a (shorter) reel.
    if (stoppedBy === 'complete' && countPending() > 0 && reels < maxReels) {
      const result = await runPipeline('manual');
      if (result.status === 'uploaded' || result.status === 'compiled') reels++;
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
