import { Events, type Client, type Message, type TextChannel } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { ingestCandidate, type IngestOutcome } from '../ingest/ingest.js';
import { extractCandidates } from './extract.js';

const REACTIONS = { accepted: '✅', duplicate: '♻️', rejected: '⚠️' } as const;

/** Downloads are network- and CPU-heavy; two at a time keeps the bot responsive. */
const MAX_CONCURRENT = 2;
let active = 0;
const queue: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => queue.push(resolve));
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

/**
 * Walks channel history newest-first and ingests anything not already recorded.
 * Discord CDN links are signed and expire, so this re-reads them from the API rather
 * than trusting anything stored earlier.
 */
export async function backfill(
  client: Client,
  limit = 500,
  onAccepted?: OnAccepted,
): Promise<{ scanned: number; accepted: number; duplicate: number; rejected: number }> {
  const channel = await client.channels.fetch(config.discord.clipsChannelId);
  if (!channel?.isTextBased()) throw new Error('clips channel is not a text channel');

  const stats = { scanned: 0, accepted: 0, duplicate: 0, rejected: 0 };
  let before: string | undefined;

  while (stats.scanned < limit) {
    const batch = await (channel as TextChannel).messages.fetch({
      limit: Math.min(100, limit - stats.scanned),
      ...(before ? { before } : {}),
    });
    if (batch.size === 0) break;

    for (const message of batch.values()) {
      stats.scanned++;
      before = message.id;
      if (message.author.bot) continue;

      for (const candidate of extractCandidates(message)) {
        const outcome = await withSlot(() => ingestCandidate(candidate));
        if (outcome.kind === 'accepted') stats.accepted++;
        else if (outcome.kind === 'duplicate') stats.duplicate++;
        else if (outcome.kind === 'rejected') stats.rejected++;
      }
    }

    logger.info(stats, 'backfill progress');
  }

  if (stats.accepted > 0) await onAccepted?.();
  return stats;
}
