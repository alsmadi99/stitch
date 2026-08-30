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
 *   npm run backfill -- --stop       ask a running backfill to stop at its next checkpoint
 *   npm run backfill -- --limit 500  only scan the next 500 messages
 *   npm run backfill -- --reels 3    stop after 3 reels instead of BACKFILL_MAX_REELS
 *   npm run backfill -- --restart    DESTRUCTIVE: wipe the database and every file
 *                                    first, then walk the channel from scratch
 *   npm run backfill -- --force      skip the confirmation delay on --restart
 */
import { config } from '../src/config.js';
import { countPending } from '../src/db/clips.js';
import { pendingUploadCount } from '../src/db/reels.js';
import { HEARTBEAT_MAX_AGE_MS, heartbeatAgeMs } from '../src/heartbeat.js';
import { readJobState, requestBackfill, requestCancel, type JobState } from '../src/jobs.js';
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
    console.log('No backfill has been run yet. Start one with: npm run backfill');
    process.exit(0);
  }

  console.log(render(state));
  if (state.stoppedBy) console.log(`stopped by  : ${state.stoppedBy}`);
  if (state.detail) console.log(`\n${state.detail}`);

  // The two numbers that decide whether it picks itself back up.
  const waiting = pendingUploadCount();
  const room = config.ingest.maxPendingUploads;
  console.log(`\nclips queued          : ${countPending()}`);
  console.log(`reels awaiting upload : ${waiting} of ${room} allowed`);

  const CONTINUABLE = ['quota', 'deferred', 'pendingCap', 'maxReels'];
  const resumable = state.status === 'done' && CONTINUABLE.includes(state.stoppedBy ?? '');

  if (state.status === 'running' || state.status === 'queued') {
    console.log('\nStill working. Nothing to do.');
  } else if (!config.ingest.backfillAutoContinue) {
    console.log('\nBACKFILL_AUTO_CONTINUE is off — re-run `npm run backfill` to continue.');
  } else if (resumable && waiting >= room) {
    console.log(
      '\nWaiting on the daily upload quota. Those reels are already built; the bot retries\n' +
        'hourly and resumes the scan by itself once they go out. Nothing to do.',
    );
  } else if (resumable) {
    console.log('\nThere is room to upload again — the hourly sweep should resume it within the hour.');
    console.log('Re-run `npm run backfill` to start now instead of waiting.');
  } else if (state.status === 'done') {
    console.log('\nReached the end of the channel. Re-run only if new clips have been posted since.');
  } else {
    console.log('\nRe-run `npm run backfill` to continue from the cursor.');
  }

  process.exit(0);
}

if (flag('stop')) {
  const { wasActive, status } = requestCancel();
  if (wasActive) {
    console.log(`Stopping the backfill (was ${status}).`);
    console.log('It finishes the reel it is compiling, then stops — that can take minutes.');
    console.log('Progress is saved; `npm run backfill` later continues from the cursor.');
  } else {
    console.log(`No backfill was running${status ? ` (last job: ${status})` : ''}. State cleared anyway.`);
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
  console.error('Watch it with --status, or stop it with --stop, then start a new one.');
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
