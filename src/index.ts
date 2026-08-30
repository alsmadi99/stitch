import { config } from './config.js';
import { logger } from './logger.js';
import { client, login } from './discord/client.js';
import { registerCollector } from './discord/collector.js';
import { deployCommands, registerCommands } from './discord/commands.js';
import { registerReactions } from './discord/reactions.js';
import { hasYtDlp } from './ingest/download.js';
import { beat } from './heartbeat.js';
import { startHttpServer } from './http.js';
import { recoverInterruptedJob, startJobRunner } from './jobs.js';
import { clearStaleLock, isRunning, recoverInterruptedReels, retryPendingUploads } from './pipeline.js';
import { cleanStaleWorkFiles } from './video/compile.js';
import { maybeRunOnThreshold, startScheduler } from './scheduler/index.js';
import { db } from './db/index.js';

async function main(): Promise<void> {
  logger.info(
    {
      channel: config.discord.clipsChannelId,
      threshold: config.trigger.maxClips,
      cron: config.trigger.cron,
      youtube: config.youtube.enabled ? config.youtube.privacy : 'disabled',
      // Logged because an OOM is almost always explained by these four numbers, and
      // without them the logs cannot tell you which config was actually in force.
      video: `${config.video.width}x${config.video.height}@${config.video.fps}`,
      ffmpegThreads: config.video.threads,
      maxClipSeconds: config.video.maxClipSeconds,
    },
    'stitch starting',
  );

  if (!config.youtube.enabled) {
    logger.warn('YouTube is not configured — reels will be compiled locally only');
  } else if (config.youtube.autoPublish && config.youtube.privacy === 'public') {
    logger.warn(
      'YOUTUBE_AUTO_PUBLISH=true with YOUTUBE_PRIVACY=public — every reel goes public the moment it uploads',
    );
  }
  if (config.ingest.allowLinks) await hasYtDlp();

  // A redeploy or crash mid-compile leaves clips attached to a reel that will never
  // finish. Put them back in the queue before anything else runs.
  recoverInterruptedReels();
  recoverInterruptedJob();
  // Nothing can legitimately hold the compile lock at boot; a leftover one would block
  // every future reel, and inside a container the pid check cannot spot it.
  clearStaleLock();
  await cleanStaleWorkFiles();

  registerCollector(client, maybeRunOnThreshold);
  registerCommands(client);
  registerReactions(client);

  await login();
  await deployCommands();
  startScheduler();

  // Heartbeat for the container healthcheck. Tied to the gateway rather than a bare
  // timer so a dead websocket actually shows up as unhealthy.
  beat();
  const heartbeat = setInterval(() => {
    if (client.isReady()) beat();
  }, 30_000);
  heartbeat.unref();

  startHttpServer(() => client.isReady());

  // Long-running jobs (the history backfill) run here rather than in a terminal
  // session, so they survive disconnects and log to the container like everything else.
  startJobRunner(client);

  // A reel deferred by a quota failure yesterday should go out without being asked.
  void retryPendingUploads().catch((err) =>
    logger.error({ err: (err as Error).message }, 'startup upload retry failed'),
  );

  logger.info('ready');
}

function shutdown(signal: string): void {
  // A compile takes minutes and the stop grace period is seconds, so there is nothing
  // useful to wait for. Say so plainly; startup recovery puts the clips back.
  if (isRunning()) {
    logger.warn({ signal }, 'shutting down mid-compile — its clips return to the queue on restart');
  } else {
    logger.info({ signal }, 'shutting down');
  }

  void client.destroy().finally(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) =>
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled rejection'),
);

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'failed to start');
  process.exit(1);
});
