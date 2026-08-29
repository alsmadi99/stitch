import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as clipsRepo from '../db/clips.js';
import * as reelsRepo from '../db/reels.js';
import { isRunning, runPipeline } from '../pipeline.js';
import { setPrivacy } from '../youtube/upload.js';
import { backfill } from './collector.js';
import { PUBLISH_BUTTON_ID } from './notify.js';

const commands = [
  new SlashCommandBuilder()
    .setName('clips')
    .setDescription('Inspect the clip queue')
    .addSubcommand((s) => s.setName('status').setDescription('Show queue size and the last reel'))
    .addSubcommand((s) =>
      s
        .setName('backfill')
        .setDescription('Scan channel history for clips posted before the bot joined')
        .addIntegerOption((o) =>
          o.setName('limit').setDescription('Messages to scan (default 500)').setMinValue(1).setMaxValue(5000),
        ),
    ),
  new SlashCommandBuilder()
    .setName('reel')
    .setDescription('Build and publish reels')
    .addSubcommand((s) => s.setName('build').setDescription('Compile a reel now, ignoring the clip threshold'))
    .addSubcommand((s) => s.setName('publish').setDescription('Make the latest uploaded reel public')),
].map((c) => c.toJSON());

export async function deployCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.appId);

  await rest.put(route, { body: commands });
  logger.info({ scope: config.discord.guildId ? 'guild' : 'global' }, 'slash commands deployed');
}

function isAuthorized(interaction: Interaction): boolean {
  const member = interaction.member as GuildMember | null;
  if (!member) return false;
  if (config.discord.adminRoleIds.length > 0) {
    return config.discord.adminRoleIds.some((id) => member.roles?.cache?.has(id));
  }
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

export function registerCommands(client: Client): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction).catch((err) =>
      logger.error({ err: (err as Error).message }, 'interaction failed'),
    );
  });
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton() && interaction.customId.startsWith(PUBLISH_BUTTON_ID)) {
    return handlePublishButton(interaction);
  }
  if (!interaction.isChatInputCommand()) return;

  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You need Manage Server for that.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === 'clips') return handleClips(interaction);
  if (interaction.commandName === 'reel') return handleReel(interaction);
}

async function handleClips(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const pending = clipsRepo.countPending();
    const last = reelsRepo.latestReel();
    const lines = [
      `**${pending}** clip${pending === 1 ? '' : 's'} queued (reel fires at ${config.trigger.maxClips}).`,
      isRunning() ? 'A reel is compiling right now.' : null,
      last
        ? `Last reel: #${last.id} — ${last.status}${last.youtube_url ? ` — ${last.youtube_url}` : ''}`
        : 'No reels yet.',
    ].filter(Boolean);

    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'backfill') {
    const limit = interaction.options.getInteger('limit') ?? 500;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const stats = await backfill(interaction.client, limit);
    await interaction.editReply(
      `Scanned ${stats.scanned} messages: ${stats.accepted} queued, ${stats.duplicate} duplicates, ${stats.rejected} rejected.`,
    );
  }
}

async function handleReel(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === 'build') {
    if (isRunning()) {
      await interaction.reply({ content: 'A reel is already compiling.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: 'Building — this takes a while. I will post the result here.',
      flags: MessageFlags.Ephemeral,
    });
    // Deliberately not awaited: compiling outlives the 15-minute interaction token.
    void runPipeline('manual').catch((err) =>
      logger.error({ err: (err as Error).message }, 'manual reel failed'),
    );
    return;
  }

  if (sub === 'publish') {
    const reel = reelsRepo.latestReel();
    if (!reel?.youtube_id) {
      await interaction.reply({ content: 'No uploaded reel to publish.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await publishReel(reel.id, reel.youtube_id);
    await interaction.editReply(`Reel #${reel.id} is public: ${reel.youtube_url}`);
  }
}

async function handlePublishButton(interaction: ButtonInteraction): Promise<void> {
  if (!isAuthorized(interaction)) {
    await interaction.reply({ content: 'You need Manage Server for that.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reelId = Number(interaction.customId.split(':').pop());
  const reel = reelsRepo.getReel(reelId);
  if (!reel?.youtube_id) {
    await interaction.reply({ content: 'That reel has no YouTube video.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await publishReel(reelId, reel.youtube_id);
  await interaction.editReply(`Published: ${reel.youtube_url}`);
  await interaction.message.edit({ components: [] }).catch(() => undefined);
}

async function publishReel(reelId: number, videoId: string): Promise<void> {
  await setPrivacy(videoId, 'public');
  reelsRepo.updateReel(reelId, { status: 'published', published_at: new Date().toISOString() });
}
