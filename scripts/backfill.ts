/**
 * Walks the channel's entire history, ingests every video in it, and turns the queue
 * into reels of at most REEL_MAX_CLIPS as it goes.
 *
 * Progress is checkpointed after every page, so this is safe to stop and re-run — it
 * resumes where it left off rather than re-downloading.
 *
 *   npm run backfill                 walk everything, resuming from last position
 *   npm run backfill -- --rescan     re-read the channel from its first message,
 *                                    keeping the database (already-seen clips skipped)
 *   npm run backfill -- --restart    DESTRUCTIVE: wipe the database and all files,
 *                                    then walk the channel from scratch
 *   npm run backfill -- --limit 500  only scan the next 500 messages
 *   npm run backfill -- --reels 3    stop after 3 reels instead of BACKFILL_MAX_REELS
 *   npm run backfill -- --scan-only  ingest but never upload
 *   npm run backfill -- --force      skip the confirmation delay on --restart
 */
import { logger } from '../src/logger.js';
import { client, login } from '../src/discord/client.js';
import { backfill } from '../src/discord/collector.js';
import { describeDrain, drainHistory } from '../src/drain.js';
import { describeState, resetState } from '../src/reset.js';

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
const rescan = flag('rescan');

if (flag('restart')) {
  const state = describeState();

  console.log('\n--restart will permanently delete:');
  console.log(`  ${state.clips} clip records (including which ones were already published)`);
  console.log(`  ${state.reels} reel records — episode numbering restarts at #1`);
  console.log('  every downloaded clip and generated reel in data/');

  if (state.published > 0) {
    console.log(
      `\n  WARNING: ${state.published} reel(s) are already on YouTube. This cannot delete them,\n` +
        '  and once the record is gone the bot will upload those clips again.',
    );
  }

  if (!flag('force')) {
    console.log('\nStarting in 8 seconds. Ctrl+C to abort, or pass --force to skip this wait.');
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }

  const summary = await resetState();
  console.log(
    `\nReset: removed ${summary.clips} clips, ${summary.reels} reels, ${summary.files} files (${summary.megabytes} MB).\n`,
  );
}

await login();

if (flag('scan-only')) {
  const stats = await backfill(client, { limit, restart: rescan });
  logger.info(stats, 'scan complete (no reels built)');
} else {
  const result = await drainHistory(client, {
    limit,
    restart: rescan,
    maxReels: option('reels'),
  });
  console.log(`\n${describeDrain(result)}\n`);
}

await client.destroy();
process.exit(0);
