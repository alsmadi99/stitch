import fs from 'node:fs';
import {
  Events,
  PermissionFlagsBits,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as clipsRepo from '../db/clips.js';
import * as reelsRepo from '../db/reels.js';
import type { ClipRow } from '../types.js';

/** Shown once a clip has been vetoed, replacing the bot's own ✅. */
const EXCLUDED_MARK = '🚫';
const ACCEPTED_MARK = '✅';

/**
 * Lets a clip be pulled out of the queue by reacting to it in Discord.
 *
 * The veto is its own clip status rather than reusing `rejected`, which means "ingest
 * failed". That distinction is what makes it stick: when a reel fails, `releaseClips`
 * returns rows whose status is `used` to the queue, so an excluded clip — no longer
 * `used` — is simply never picked back up.
 *
 * Removing the reaction restores the clip, so the source file is kept rather than
 * deleted. Vetoes are rare and manual, so the disk cost is noise.
 */
export function registerReactions(client: Client): void {
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void handle(reaction, user, 'exclude').catch((err) =>
      logger.error({ err: (err as Error).message }, 'reaction handler failed'),
    );
  });

  client.on(Events.MessageReactionRemove, (reaction, user) => {
    void handle(reaction, user, 'restore').catch((err) =>
      logger.error({ err: (err as Error).message }, 'reaction handler failed'),
    );
  });

  logger.info({ emoji: config.discord.rejectReaction }, 'clip veto reaction active');
}

async function handle(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  action: 'exclude' | 'restore',
): Promise<void> {
  if (user.bot) return;

  // Reactions on messages the bot has not cached — anything backfilled — arrive partial.
  if (reaction.partial) await reaction.fetch();
  if (reaction.emoji.name !== config.discord.rejectReaction) return;

  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (message.channelId !== config.discord.clipsChannelId) return;

  const clips = clipsRepo.findByMessageId(message.id);
  if (clips.length === 0) return;

  const actor = user.partial ? await user.fetch() : user;
  if (!(await isAllowed(actor.id, clips, message))) {
    logger.warn({ user: actor.id, messageId: message.id }, 'ignored a veto from an unauthorized user');
    return;
  }

  const results = clips.map((clip) => (action === 'exclude' ? exclude(clip) : restore(clip)));
  const changed = results.filter((r) => r.changed).length;

  logger.info(
    { messageId: message.id, user: actor.id, action, changed, outcomes: results.map((r) => r.outcome) },
    'clip veto processed',
  );

  if (changed > 0) await markMessage(message as Message, action);
}

interface Outcome {
  changed: boolean;
  outcome: string;
}

function exclude(clip: ClipRow): Outcome {
  if (clip.status === 'excluded') return { changed: false, outcome: 'already excluded' };

  if (clip.status === 'used') {
    const reel = clip.reel_id ? reelsRepo.getReel(clip.reel_id) : undefined;

    // Once a reel is on YouTube the clip is in a published video; the database cannot
    // take it back out. Flagging it anyway keeps it out of any future reel.
    if (reel && ['uploaded', 'published', 'pending_upload', 'uploading'].includes(reel.status)) {
      clipsRepo.setStatus(clip.id, 'excluded', `vetoed after reel ${reel.id} was already built`);
      return { changed: true, outcome: `too late — already in reel ${reel.id}` };
    }
  }

  clipsRepo.setStatus(clip.id, 'excluded', 'vetoed by reaction');
  return { changed: true, outcome: 'excluded' };
}

function restore(clip: ClipRow): Outcome {
  if (clip.status !== 'excluded') return { changed: false, outcome: 'not excluded' };

  // The download is kept when a clip is vetoed precisely so this can undo it.
  if (!clip.file_path || !fs.existsSync(clip.file_path)) {
    return { changed: false, outcome: 'source file is gone — repost to requeue' };
  }

  clipsRepo.updateClip(clip.id, { status: 'pending', reel_id: null, note: 'restored by reaction' });
  return { changed: true, outcome: 'restored' };
}

/**
 * Who may veto, decided by `VETO_ALLOWED`:
 *
 * - `owner`   — only ADMIN_USER_IDS
 * - `admins`  — plus ADMIN_ROLE_IDS, or Manage Server when no roles are listed
 * - `authors` — plus whoever posted the clip, so people can withdraw their own
 *
 * ADMIN_USER_IDS always passes; the setting only widens the circle beyond it. Kept pure
 * so the matrix can be tested without a Discord connection.
 */
export function mayVeto(
  scope: 'owner' | 'admins' | 'authors',
  who: { owner: boolean; admin: boolean; author: boolean },
): boolean {
  if (who.owner) return true;
  if (scope === 'owner') return false;
  if (who.admin) return true;
  return scope === 'authors' && who.author;
}

async function isAllowed(userId: string, clips: ClipRow[], message: Message): Promise<boolean> {
  const owner = config.discord.adminUserIds.includes(userId);
  // Only true when every clip on the message is theirs — a post cannot be half withdrawn.
  const author = clips.every((c) => c.author_id === userId);

  let admin = false;
  if (!owner && config.discord.vetoAllowed !== 'owner') {
    const member = await message.guild?.members.fetch(userId).catch(() => null);
    admin = member
      ? config.discord.adminRoleIds.length > 0
        ? config.discord.adminRoleIds.some((id) => member.roles.cache.has(id))
        : member.permissions.has(PermissionFlagsBits.ManageGuild)
      : false;
  }

  return mayVeto(config.discord.vetoAllowed, { owner, admin, author });
}

/** Swaps the bot's own ✅ for 🚫 so the queue state is visible in the channel. */
async function markMessage(message: Message, action: 'exclude' | 'restore'): Promise<void> {
  const selfId = message.client.user?.id;
  if (!selfId) return;

  const [add, remove] =
    action === 'exclude' ? [EXCLUDED_MARK, ACCEPTED_MARK] : [ACCEPTED_MARK, EXCLUDED_MARK];

  await message.reactions.cache.get(remove)?.users.remove(selfId).catch(() => undefined);
  await message.react(add).catch(() => undefined);
}
