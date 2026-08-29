import type { Client } from 'discord.js';
import { kvGet, kvSet } from './db/index.js';
import { db } from './db/index.js';
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
}

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
export function requestBackfill(request: Omit<JobRequest, 'kind' | 'requestedAt'>): JobState {
  const full: JobRequest = { kind: 'backfill', requestedAt: new Date().toISOString(), ...request };
  kvSet(REQUEST_KEY, JSON.stringify(full));

  const state: JobState = { kind: 'backfill', status: 'queued', requestedAt: full.requestedAt };
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

  writeJobState({
    ...state,
    status: 'interrupted',
    finishedAt: new Date().toISOString(),
    detail: 'stopped by a restart — run the backfill again to continue from the cursor',
  });
  logger.warn({ job: state.kind }, 'marked an interrupted job');
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

  const publish = (status: JobState['status'], extra: Partial<JobState> = {}) =>
    writeJobState({
      kind: 'backfill',
      status,
      requestedAt: request.requestedAt,
      startedAt,
      progress,
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
  });

  logger.info({ stoppedBy: result.stoppedBy, reels: result.reels }, 'backfill job finished');
}
