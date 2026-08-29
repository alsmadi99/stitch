import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type SendableChannels,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { client } from './client.js';

export const PUBLISH_BUTTON_ID = 'reel:publish';

async function announceChannel(): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(config.discord.announceChannelId).catch(() => null);
  if (!channel?.isSendable()) {
    logger.error({ id: config.discord.announceChannelId }, 'announce channel is not sendable');
    return null;
  }
  return channel;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

export interface ReelAnnouncement {
  title: string;
  duration: number;
  clipCount: number;
  youtubeUrl?: string;
  privacy?: string;
}

export async function announceReel(reelId: number, info: ReelAnnouncement): Promise<void> {
  const channel = await announceChannel();
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(info.title)
    .setColor(0x5865f2)
    .addFields(
      { name: 'Clips', value: String(info.clipCount), inline: true },
      { name: 'Length', value: formatDuration(info.duration), inline: true },
      {
        name: 'Status',
        value: info.youtubeUrl ? (info.privacy ?? 'uploaded') : 'compiled locally',
        inline: true,
      },
    )
    .setFooter({ text: `reel #${reelId}` })
    .setTimestamp(new Date());

  if (info.youtubeUrl) embed.setURL(info.youtubeUrl).setDescription(info.youtubeUrl);

  // Nothing goes public without a human clicking, unless YOUTUBE_AUTO_PUBLISH is on.
  const needsApproval =
    Boolean(info.youtubeUrl) && !config.youtube.autoPublish && info.privacy !== 'public';

  const components = needsApproval
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${PUBLISH_BUTTON_ID}:${reelId}`)
            .setLabel('Publish to YouTube')
            .setStyle(ButtonStyle.Success),
        ),
      ]
    : [];

  await channel.send({ embeds: [embed], components });
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
