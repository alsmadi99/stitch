import type { Client } from 'discord.js';
import { config } from './config.js';
import { kvGet, kvSet } from './db/index.js';
import { db } from './db/index.js';
import { pendingUploadCount } from './db/reels.js';
import { logger } from './logger.js';
import { describeDrain, drainHistory, type DrainResult } from './drain.js';
import { resetState } from './reset.js';

/**
 * A one-slot job queue in the database.
 *
 * A history backfill runs for hours, so it cannot live in a terminal session — closing
 * the tab kills the pty and, sooner or later, the process. Running it inside the bot
 * instead means it survives disconnects, its output goes to the container log like
 * everything else, and /health can report on it. The CLI becomes a client that files a
 * request and watches.
 */

const REQUEST_KEY = 'job:request';
const STATE_KEY = 'job:state';

export interface JobRequest {
  kind: 'backfill';
  limit?: number;
  maxReels?: number;
  /** Wipe the database and all files before starting. */
  restart?: boolean;
  requestedAt: string;
}

export interface JobProgress {
  scanned: number;
  accepted: number;
  duplicate: number;
  rejected: number;
  reels: number;
}

export interface JobState {
  kind: 'backfill';
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: JobProgress;
  detail?: string;
  /** The originating request, so an interrupted job can be resumed after a restart. */
  request?: Omit<JobRequest, 'kind' | 'requestedAt'>;
  /** How many times this job has been auto-resumed, to bound a restart loop. */
  resumes?: number;
  /** Why the last run ended, so the scheduler can decide whether to continue it. */
  stoppedBy?: string;
}

/** Enough restarts to survive a rolling deploy; few enough to expose a crash loop. */
const MAX_AUTO_RESUMES = 3;

function readJson<T>(key: string): T | null {
  const raw = kvGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readJobState(): JobState | null {
  return readJson<JobState>(STATE_KEY);
}

export function writeJobState(state: JobState): void {
  kvSet(STATE_KEY, JSON.stringify(state));
}

/** Files a request and marks it queued. Called by the CLI, picked up by the bot. */
export function requestBackfill(
  request: Omit<JobRequest, 'kind' | 'requestedAt'>,
  resumes = 0,
): JobState {
  const full: JobRequest = { kind: 'backfill', requestedAt: new Date().toISOString(), ...request };
  kvSet(REQUEST_KEY, JSON.stringify(full));

  const state: JobState = {
    kind: 'backfill',
    status: 'queued',
    requestedAt: full.requestedAt,
    request,
    resumes,
  };
  writeJobState(state);
  return state;
}

/** Reads and clears the pending request in one transaction, so two ticks cannot race. */
function claimRequest(): JobRequest | null {
  const claim = db.transaction(() => {
    const raw = kvGet(REQUEST_KEY);
    if (!raw) return null;
    db.prepare('DELETE FROM kv WHERE key = ?').run(REQUEST_KEY);
    return raw;
  });

  const raw = claim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as JobRequest;
  } catch {
    return null;
  }
}

/**
 * A job marked running when the process starts belongs to a previous life of this
 * container — nothing else could have written it. Left alone it would block every
 * future request.
 */
export function recoverInterruptedJob(): void {
  const state = readJobState();
  if (!state || (state.status !== 'running' && state.status !== 'queued')) return;

  const resumes = (state.resumes ?? 0) + 1;
  const canResume = Boolean(state.request) && resumes <= MAX_AUTO_RESUMES;

  writeJobState({
    ...state,
    status: 'interrupted',
    finishedAt: new Date().toISOString(),
    detail: canResume
      ? 'stopped by a restart — resuming automatically from the cursor'
      : 'stopped by a restart — run the backfill again to continue from the cursor',
  });
  logger.warn({ resumes, canResume }, 'marked an interrupted job');

  if (!canResume) return;

  // Never repeat a --restart. It wiped the database once already; doing it again on
  // every boot would erase the very progress this resume exists to preserve.
  requestBackfill({ ...state.request!, restart: false }, resumes);
  logger.info({ resumes }, 'queued an automatic resume of the interrupted backfill');
}

/**
 * Reasons a run ended with work still to do. The daily upload quota is the usual one:
 * six uploads a day is a hard ceiling, so a large history simply takes several days.
 * Continuing automatically is what turns that into one command instead of one a day.
 */
const CONTINUABLE = new Set(['quota', 'deferred', 'pendingCap', 'maxReels']);

/**
 * Re-queues a backfill that stopped early, once there is room to upload again. Called
 * on the scheduler's hourly tick.
 */
export function maybeContinueBackfill(): boolean {
  if (!config.ingest.backfillAutoContinue) return false;

  const state = readJobState();
  if (!state || state.status !== 'done' || !state.request) return false;
  if (!state.stoppedBy || !CONTINUABLE.has(state.stoppedBy)) return false;

  // Only worth resuming once the built-but-unuploaded backlog has drained, otherwise
  // it would immediately stop again on the same cap.
  const waiting = pendingUploadCount();
  if (waiting >= config.ingest.maxPendingUploads) {
    logger.debug({ waiting }, 'not continuing the backfill yet — uploads still queued');
    return false;
  }

  logger.info({ stoppedBy: state.stoppedBy, waiting }, 'continuing the backfill automatically');
  requestBackfill({ ...state.request, restart: false });
  return true;
}

let busy = false;

export function startJobRunner(client: Client, intervalMs = 5000): NodeJS.Timeout {
  logger.info('job runner started');
  return setInterval(() => {
    void tick(client);
  }, intervalMs);
}

async function tick(client: Client): Promise<void> {
  if (busy) return;

  const request = claimRequest();
  if (!request) return;

  busy = true;
  try {
    await runBackfill(client, request);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error({ err: detail }, 'backfill job failed');
    writeJobState({
      kind: 'backfill',
      status: 'failed',
      requestedAt: request.requestedAt,
      finishedAt: new Date().toISOString(),
      detail,
    });
  } finally {
    busy = false;
  }
}

async function runBackfill(client: Client, request: JobRequest): Promise<void> {
  const startedAt = new Date().toISOString();
  let progress: JobProgress = { scanned: 0, accepted: 0, duplicate: 0, rejected: 0, reels: 0 };

  // Carried through every write: without them a restart mid-run would find no request
  // to resume, which is precisely the case auto-resume exists for. The reset is dropped
  // here so a resume can never repeat it.
  const resumes = readJobState()?.resumes ?? 0;
  const resumable: Omit<JobRequest, 'kind' | 'requestedAt'> = {
    limit: request.limit,
    maxReels: request.maxReels,
    restart: false,
  };

  const publish = (status: JobState['status'], extra: Partial<JobState> = {}) =>
    writeJobState({
      kind: 'backfill',
      status,
      requestedAt: request.requestedAt,
      startedAt,
      progress,
      request: resumable,
      resumes,
      ...extra,
    });

  publish('running');
  logger.info({ request }, 'backfill job started');

  if (request.restart) {
    const summary = await resetState();
    logger.warn(summary, 'backfill job reset all state before starting');
  }

  const result: DrainResult = await drainHistory(client, {
    limit: request.limit,
    maxReels: request.maxReels,
    onProgress: (p) => {
      progress = p;
      publish('running');
    },
  });

  progress = {
    scanned: result.scanned,
    accepted: result.accepted,
    duplicate: result.duplicate,
    rejected: result.rejected,
    reels: result.reels,
  };

  publish(result.stoppedBy === 'error' ? 'failed' : 'done', {
    finishedAt: new Date().toISOString(),
    detail: describeDrain(result),
    stoppedBy: result.stoppedBy,
  });

  logger.info({ stoppedBy: result.stoppedBy, reels: result.reels }, 'backfill job finished');
}
