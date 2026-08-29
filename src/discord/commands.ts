import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
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
import { describeDrain, drainHistory } from '../drain.js';

const commands = [
  new SlashCommandBuilder()
    .setName('clips')
    .setDescription('Inspect the clip queue')
    .addSubcommand((s) => s.setName('status').setDescription('Show queue size and the last reel'))
    .addSubcommand((s) =>
      s
        .setName('backfill')
        .setDescription('Scan the whole channel history and build reels from every clip in it')
        .addIntegerOption((o) =>
          o
            .setName('limit')
            .setDescription('Only scan this many messages (default: everything)')
            .setMinValue(1)
            .setMaxValue(100000),
        )
        .addIntegerOption((o) =>
          o
            .setName('reels')
            .setDescription('Stop after this many reels (default: BACKFILL_MAX_REELS)')
            .setMinValue(1)
            .setMaxValue(20),
        )
        .addBooleanOption((o) =>
          o
            .setName('restart')
            .setDescription('Start again from the first message instead of resuming'),
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
    if (isRunning()) {
      await interaction.reply({ content: 'A reel is compiling — try again once it finishes.', flags: MessageFlags.Ephemeral });
      return;
    }

    const limit = interaction.options.getInteger('limit') ?? undefined;
    const maxReels = interaction.options.getInteger('reels') ?? undefined;
    const restart = interaction.options.getBoolean('restart') ?? false;

    await interaction.reply({
      content: [
        restart
          ? 'Rescanning the channel from its first message.'
          : 'Scanning the channel history from where the last run stopped.',
        'Each batch of clips is uploaded as its own reel and the link is posted here.',
        'This runs for as long as it needs — check progress with `/clips status`.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });

    // Not awaited: a full history walk far outlives the 15 minute interaction token.
    void drainHistory(interaction.client, { limit, restart, maxReels })
      .then((result) => logger.info({ summary: describeDrain(result) }, 'backfill finished'))
      .catch((err) => logger.error({ err: (err as Error).message }, 'backfill failed'));
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
    try {
      await publishReel(reel.id, reel.youtube_id);
      await interaction.editReply(`Reel #${reel.id} is public: ${reel.youtube_url}`);
    } catch (err) {
      await interaction.editReply(publishErrorMessage(err));
    }
  }
}

/**
 * A Google Cloud project that has not passed API verification cannot flip a video to
 * public — the API answers 403 no matter what the channel's own permissions are.
 */
function publishErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/forbidden|403/i.test(message)) {
    return 'YouTube refused the change (403). Unverified API projects cannot make a video public — flip it in YouTube Studio instead.';
  }
  return `Publish failed: ${message}`;
}

async function publishReel(reelId: number, videoId: string): Promise<void> {
  await setPrivacy(videoId, 'public');
  reelsRepo.updateReel(reelId, { status: 'published', published_at: new Date().toISOString() });
}
