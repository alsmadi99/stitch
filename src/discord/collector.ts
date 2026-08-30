import { Events, type Client, type Message, type TextChannel } from 'discord.js';
import { config } from '../config.js';
import { countPending } from '../db/clips.js';
import { kvGet, kvSet } from '../db/index.js';
import { logger } from '../logger.js';
import { ingestCandidate, type IngestOutcome } from '../ingest/ingest.js';
import { extractCandidates } from './extract.js';

const REACTIONS = { accepted: '✅', duplicate: '♻️', rejected: '⚠️' } as const;

/** Downloads are network- and CPU-heavy; a small pool keeps the gateway responsive. */
let active = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.ingest.concurrency) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export type OnAccepted = () => void | Promise<void>;

export function registerCollector(client: Client, onAccepted?: OnAccepted): void {
  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, onAccepted);
  });
  logger.info({ channel: config.discord.clipsChannelId }, 'watching for clips');
}

async function handleMessage(message: Message, onAccepted?: OnAccepted): Promise<void> {
  if (message.author.bot) return;
  if (message.channelId !== config.discord.clipsChannelId) return;

  const candidates = extractCandidates(message);
  if (candidates.length === 0) return;

  const outcomes: IngestOutcome[] = [];
  for (const candidate of candidates) {
    outcomes.push(await withSlot(() => ingestCandidate(candidate)));
  }

  await react(message, outcomes);

  if (outcomes.some((o) => o.kind === 'accepted')) await onAccepted?.();
}

async function react(message: Message, outcomes: IngestOutcome[]): Promise<void> {
  const emoji = outcomes.some((o) => o.kind === 'accepted')
    ? REACTIONS.accepted
    : outcomes.some((o) => o.kind === 'duplicate')
      ? REACTIONS.duplicate
      : outcomes.some((o) => o.kind === 'rejected')
        ? REACTIONS.rejected
        : null;

  if (!emoji) return;
  await message.react(emoji).catch(() => undefined);
}

export interface BackfillStats {
  scanned: number;
  accepted: number;
  duplicate: number;
  rejected: number;
}

export interface BackfillOptions {
  /** Messages to scan. Omit to walk the entire channel history. */
  limit?: number;
  /** Ignore the saved cursor and start again from the very first message. */
  restart?: boolean;
  /**
   * Called once the queue is deep enough to build a reel. Return false to stop the
   * scan — used to respect the daily upload quota.
   */
  onThreshold?: () => Promise<boolean>;
  onProgress?: (stats: BackfillStats) => void;
  /** Polled between pages and before each reel; returning true ends the scan cleanly. */
  shouldStop?: () => boolean;
}

function cursorKey(): string {
  return `backfill:cursor:${config.discord.clipsChannelId}`;
}

/**
 * Walks the channel from its first message forward, ingesting every video and ignoring
 * everything else. The position is checkpointed after each page, so a restart — or a
 * container redeploy halfway through — resumes instead of re-downloading.
 *
 * Forward order matters: reels come out chronological, and with `onThreshold` wired up
 * the queue is drained into a reel every 20 clips instead of downloading the entire
 * channel to disk first.
 */
export async function backfill(
  client: Client,
  options: BackfillOptions = {},
): Promise<BackfillStats> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const channel = await client.channels.fetch(config.discord.clipsChannelId);
  if (!channel?.isTextBased()) throw new Error('clips channel is not a text channel');

  if (options.restart) kvSet(cursorKey(), '0');

  // Snowflake 0 predates Discord itself, so "after 0" is the start of the channel.
  let after = kvGet(cursorKey()) ?? '0';
  const stats: BackfillStats = { scanned: 0, accepted: 0, duplicate: 0, rejected: 0 };

  for (;;) {
    if (stats.scanned >= limit) break;
    if (options.shouldStop?.()) {
      logger.info(stats, 'backfill stopped on request');
      break;
    }

    const page = await (channel as TextChannel).messages.fetch({
      limit: Math.min(100, limit - stats.scanned),
      after,
    });
    if (page.size === 0) break;

    // Discord returns a page newest-first; process it oldest-first.
    const messages = [...page.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

    for (const message of messages) {
      stats.scanned++;
      after = message.id;
      if (message.author.bot) continue;

      for (const candidate of extractCandidates(message)) {
        const outcome = await withSlot(() => ingestCandidate(candidate));
        if (outcome.kind === 'accepted') stats.accepted++;
        else if (outcome.kind === 'duplicate') stats.duplicate++;
        else if (outcome.kind === 'rejected') stats.rejected++;
      }

      if (outcomeNeedsReel(options)) {
        // Checkpoint before a long compile so a crash mid-reel does not rewind the scan.
        kvSet(cursorKey(), after);
        if (!(await options.onThreshold!())) {
          logger.info(stats, 'backfill stopped early by the reel handler');
          return stats;
        }
      }
    }

    kvSet(cursorKey(), after);
    options.onProgress?.(stats);
    logger.info(stats, 'backfill progress');
  }

  return stats;
}

function outcomeNeedsReel(options: BackfillOptions): boolean {
  return Boolean(options.onThreshold) && countPending() >= config.trigger.maxClips;
}
