import { config } from './config.js';
import { logger } from './logger.js';
import { client, login } from './discord/client.js';
import { registerCollector } from './discord/collector.js';
import { deployCommands, registerCommands } from './discord/commands.js';
import { hasYtDlp } from './ingest/download.js';
import { beat } from './heartbeat.js';
import { startHttpServer } from './http.js';
import { maybeRunOnThreshold, startScheduler } from './scheduler/index.js';
import { db } from './db/index.js';

async function main(): Promise<void> {
  logger.info(
    {
      channel: config.discord.clipsChannelId,
      threshold: config.trigger.maxClips,
      cron: config.trigger.cron,
      youtube: config.youtube.enabled ? config.youtube.privacy : 'disabled',
    },
    'clipreel starting',
  );

  if (!config.youtube.enabled) {
    logger.warn('YouTube is not configured — reels will be compiled locally only');
  }
  if (config.ingest.allowLinks) await hasYtDlp();

  registerCollector(client, maybeRunOnThreshold);
  registerCommands(client);

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

  logger.info('ready');
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
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
