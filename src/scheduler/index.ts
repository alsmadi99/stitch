import cron from 'node-cron';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { countPending } from '../db/clips.js';
import { isRunning, retryPendingUploads, runPipeline } from '../pipeline.js';
import { maybeContinueBackfill } from '../jobs.js';

export function startScheduler(): void {
  if (!cron.validate(config.trigger.cron)) {
    throw new Error(`REEL_CRON is not a valid cron expression: ${config.trigger.cron}`);
  }

  cron.schedule(
    config.trigger.cron,
    () => {
      logger.info('weekly trigger fired');
      void runPipeline('cron').then(
        (res) => logger.info(res, 'weekly run finished'),
        (err) => logger.error({ err: (err as Error).message }, 'weekly run failed'),
      );
    },
    { timezone: process.env.TZ || undefined },
  );

  // Deferred uploads retry on their own. Hourly is fine: quota resets daily and the
  // per-reel backoff decides what is actually due.
  const retries = setInterval(
    () => {
      void retryPendingUploads().then(
        (n) => {
          if (n > 0) logger.info({ uploaded: n }, 'retried deferred uploads');
          // Uploading frees capacity, so check straight after whether the history scan
          // can pick up where the quota stopped it.
          maybeContinueBackfill();
        },
        (err) => logger.error({ err: (err as Error).message }, 'upload retry sweep failed'),
      );
    },
    60 * 60_000,
  );
  retries.unref();

  logger.info({ cron: config.trigger.cron, tz: process.env.TZ ?? 'system' }, 'scheduler started');
}

/**
 * Called after each accepted clip. Fires a reel the moment the queue reaches the
 * threshold, so a busy week does not wait for Sunday.
 */
export async function maybeRunOnThreshold(): Promise<void> {
  if (isRunning()) return;

  const pending = countPending();
  if (pending < config.trigger.maxClips) {
    logger.debug({ pending, threshold: config.trigger.maxClips }, 'below threshold');
    return;
  }

  logger.info({ pending }, 'threshold reached');
  await runPipeline('threshold').catch((err) =>
    logger.error({ err: (err as Error).message }, 'threshold run failed'),
  );
}
