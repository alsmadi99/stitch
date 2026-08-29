/**
 * Walks the channel's entire history, ingests every video in it, and turns the queue
 * into reels of at most REEL_MAX_CLIPS as it goes.
 *
 * Progress is checkpointed after every page, so this is safe to stop and re-run — it
 * resumes where it left off rather than re-downloading.
 *
 *   npm run backfill                 walk everything, resuming from last position
 *   npm run backfill -- --restart    start again from the first message in the channel
 *   npm run backfill -- --limit 500  only scan the next 500 messages
 *   npm run backfill -- --reels 3    stop after 3 reels instead of BACKFILL_MAX_REELS
 *   npm run backfill -- --scan-only  ingest but never upload
 */
import { logger } from '../src/logger.js';
import { client, login } from '../src/discord/client.js';
import { backfill } from '../src/discord/collector.js';
import { describeDrain, drainHistory } from '../src/drain.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : undefined;
}

const limit = option('limit');
const restart = flag('restart');

await login();

if (flag('scan-only')) {
  const stats = await backfill(client, { limit, restart });
  logger.info(stats, 'scan complete (no reels built)');
} else {
  const result = await drainHistory(client, { limit, restart, maxReels: option('reels') });
  console.log(`\n${describeDrain(result)}\n`);
}

await client.destroy();
process.exit(0);
