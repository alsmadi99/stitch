/**
 * Deletes the videos this bot uploaded, using the reel records as the list.
 *
 * YouTube has no way to replace a video's file — an upload is bound to its id for life.
 * Re-uploading a corrected reel always produces a new link, so a bad batch has to be
 * deleted rather than fixed in place.
 *
 * Run this BEFORE `backfill --restart`: the reset wipes the reel table, and with it the
 * only record of which video ids belong to the bot.
 *
 *   npm run youtube:cleanup             list what would be deleted, delete nothing
 *   npm run youtube:cleanup -- --yes    actually delete them
 *   npm run youtube:cleanup -- --yes --keep 3   spare the 3 most recent reels
 */
import { config } from '../src/config.js';
import { db } from '../src/db/index.js';
import { updateReel } from '../src/db/reels.js';
import { youtubeClient } from '../src/youtube/auth.js';
import type { ReelRow } from '../src/types.js';

function option(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : undefined;
}

if (!config.youtube.enabled) {
  console.error('YouTube is not configured — nothing to clean up.');
  process.exit(1);
}

const keep = option('keep') ?? 0;
const confirmed = process.argv.includes('--yes');

const all = db
  .prepare('SELECT * FROM reels WHERE youtube_id IS NOT NULL ORDER BY id DESC')
  .all() as ReelRow[];

const targets = all.slice(keep);

if (targets.length === 0) {
  console.log('No uploaded reels recorded — nothing to delete.');
  process.exit(0);
}

console.log(`${all.length} uploaded reel(s) on record${keep > 0 ? `, sparing the newest ${keep}` : ''}:\n`);
for (const reel of targets) {
  console.log(`  reel #${reel.id}  ${reel.youtube_url}  ${reel.status}  ${reel.title ?? ''}`);
}

if (!confirmed) {
  console.log(`\nDry run. Nothing was deleted. Add --yes to delete these ${targets.length} video(s).`);
  process.exit(0);
}

// 50 quota units each, against a 10,000/day budget — a full cleanup is cheap next to
// the 1,600 an upload costs.
const youtube = youtubeClient();
let deleted = 0;
let failed = 0;

for (const reel of targets) {
  try {
    await youtube.videos.delete({ id: reel.youtube_id! });
    updateReel(reel.id, {
      status: 'failed',
      error: 'video deleted from YouTube by cleanup',
      youtube_id: null,
      youtube_url: null,
    });
    deleted++;
    console.log(`deleted reel #${reel.id}`);
  } catch (err) {
    failed++;
    console.error(`reel #${reel.id}: ${(err as Error).message}`);
  }
}

console.log(`\n${deleted} deleted, ${failed} failed.`);
db.close();
process.exit(failed > 0 ? 1 : 0);
