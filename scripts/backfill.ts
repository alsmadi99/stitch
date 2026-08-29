/**
 * Asks the running bot to walk the channel history and build reels from it, then
 * follows along.
 *
 * The work happens inside the bot process, not here — so it survives this terminal
 * closing, its output goes to the container log, and /health reports on it. Ctrl+C
 * stops watching; it does not stop the job.
 *
 *   npm run backfill                 walk everything, resuming from last position
 *   npm run backfill -- --status     show the current job and exit
 *   npm run backfill -- --limit 500  only scan the next 500 messages
 *   npm run backfill -- --reels 3    stop after 3 reels instead of BACKFILL_MAX_REELS
 *   npm run backfill -- --restart    DESTRUCTIVE: wipe the database and every file
 *                                    first, then walk the channel from scratch
 *   npm run backfill -- --force      skip the confirmation delay on --restart
 */
import { HEARTBEAT_MAX_AGE_MS, heartbeatAgeMs } from '../src/heartbeat.js';
import { readJobState, requestBackfill, type JobState } from '../src/jobs.js';
import { describeState } from '../src/reset.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): number | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : undefined;
}

function render(state: JobState): string {
  const p = state.progress;
  const counts = p
    ? `scanned ${p.scanned}, queued ${p.accepted}, duplicates ${p.duplicate}, rejected ${p.rejected}, reels ${p.reels}`
    : 'no progress yet';
  return `[${state.status}] ${counts}`;
}

if (flag('status')) {
  const state = readJobState();
  if (!state) {
    console.log('No backfill has been run yet.');
  } else {
    console.log(render(state));
    if (state.detail) console.log(`\n${state.detail}`);
  }
  process.exit(0);
}

// The job runs inside the bot, so there is no point filing a request it will never see.
const age = heartbeatAgeMs();
if (age === null || age > HEARTBEAT_MAX_AGE_MS) {
  console.error(
    'The bot does not appear to be running — it is what executes the backfill.\n' +
      'Check the container logs and /health, then try again.',
  );
  process.exit(1);
}

const running = readJobState();
if (running?.status === 'running' || running?.status === 'queued') {
  console.error(`A backfill is already ${running.status}: ${render(running)}`);
  console.error('Watch it with --status, or wait for it to finish.');
  process.exit(1);
}

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
}

requestBackfill({
  limit: option('limit'),
  maxReels: option('reels'),
  restart: flag('restart'),
});

console.log('Backfill queued. It runs inside the bot, so this terminal can be closed.');
console.log('Following along — Ctrl+C stops watching, not the job.\n');

let lastLine = '';
for (;;) {
  const state = readJobState();
  if (!state) break;

  const line = render(state);
  if (line !== lastLine) {
    console.log(`${new Date().toLocaleTimeString()}  ${line}`);
    lastLine = line;
  }

  if (state.status !== 'queued' && state.status !== 'running') {
    if (state.detail) console.log(`\n${state.detail}`);
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

process.exit(0);
