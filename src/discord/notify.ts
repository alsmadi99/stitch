import { EmbedBuilder, type SendableChannels } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { client } from './client.js';

async function announceChannel(): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(config.discord.announceChannelId).catch(() => null);
  if (!channel?.isSendable()) {
    logger.error({ id: config.discord.announceChannelId }, 'announce channel is not sendable');
    return null;
  }
  return channel;
}

export interface ReelAnnouncement {
  title: string;
  duration: number;
  clipCount: number;
  youtubeUrl?: string;
  privacy?: string;
}

/**
 * Posts the bare YouTube link and nothing else — Discord unfurls it into a player card
 * on its own. No embed, no buttons, no call to action.
 */
export async function announceReel(_reelId: number, info: ReelAnnouncement): Promise<void> {
  const channel = await announceChannel();
  if (!channel) return;

  if (!info.youtubeUrl) {
    // Local-only mode has no link to share; say the reel exists and stop there.
    logger.info({ title: info.title }, 'compiled without upload — nothing to link');
    return;
  }

  await channel.send({ content: info.youtubeUrl });
}

export async function announceFailure(reelId: number, error: string): Promise<void> {
  const channel = await announceChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle('Reel failed')
    .setColor(0xed4245)
    .setDescription(`\`\`\`${error.slice(0, 1800)}\`\`\``)
    .setFooter({ text: `reel #${reelId} — clips were returned to the queue` });

  await channel.send({ embeds: [embed] });
}
