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
import { isCompilingAnywhere, isRunning, runPipeline } from '../pipeline.js';
import { setPrivacy } from '../youtube/upload.js';

/**
 * Backfill is intentionally absent from Discord.
 *
 * It walks the entire channel history, downloads gigabytes, and uploads several videos
 * against a daily quota that allows six. A chat command is the wrong trigger for that
 * no matter who is allowed to send it — one mistaken invocation costs a day of uploads
 * and cannot be called back. It lives in `scripts/backfill.ts`, run from the server.
 */
function commandDefinitions() {
  const commands = [
    new SlashCommandBuilder()
      .setName('clips')
      .setDescription('Inspect the clip queue')
      .addSubcommand((s) => s.setName('status').setDescription('Show queue size and the last reel')),
  ];

  // Registered only when an explicit user allowlist exists. Without one there is no
  // safe answer to "who may spend the upload quota", so the commands do not exist.
  if (config.discord.adminUserIds.length > 0) {
    commands.push(
      new SlashCommandBuilder()
        .setName('reel')
        .setDescription('Build and publish reels')
        .addSubcommand((s) =>
          s.setName('build').setDescription('Compile a reel now, ignoring the clip threshold'),
        )
        .addSubcommand((s) =>
          s.setName('publish').setDescription('Make the latest uploaded reel public'),
        ),
    );
  }

  return commands.map((c) => c.toJSON());
}

export async function deployCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.appId);

  const body = commandDefinitions();
  await rest.put(route, { body });

  logger.info(
    {
      scope: config.discord.guildId ? 'guild' : 'global',
      commands: body.map((c) => c.name),
      privileged: config.discord.adminUserIds.length > 0 ? 'enabled' : 'disabled (ADMIN_USER_IDS unset)',
    },
    'slash commands deployed',
  );
}

/** Named in ADMIN_USER_IDS. The only identity that may trigger an upload from chat. */
function isOwner(interaction: Interaction): boolean {
  return config.discord.adminUserIds.includes(interaction.user.id);
}

/** Read-only access: an owner, an allowed role, or Manage Server when neither is set. */
function canReadStatus(interaction: Interaction): boolean {
  if (isOwner(interaction)) return true;

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

  if (interaction.commandName === 'clips') return handleClips(interaction);
  if (interaction.commandName === 'reel') return handleReel(interaction);
}

async function deny(interaction: ChatInputCommandInteraction, reason: string): Promise<void> {
  logger.warn(
    { user: interaction.user.id, command: interaction.commandName },
    'rejected an unauthorized command',
  );
  await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
}

async function handleClips(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canReadStatus(interaction)) {
    await deny(interaction, 'You are not allowed to run that.');
    return;
  }

  const pending = clipsRepo.countPending();
  const awaitingUpload = reelsRepo.pendingUploadCount();
  const last = reelsRepo.latestReel();
  const lines = [
    `**${pending}** clip${pending === 1 ? '' : 's'} queued (reel fires at ${config.trigger.maxClips}).`,
    isCompilingAnywhere() ? 'A reel is compiling right now.' : null,
    awaitingUpload > 0
      ? `${awaitingUpload} built reel${awaitingUpload === 1 ? '' : 's'} waiting to upload — retrying automatically.`
      : null,
    last
      ? `Last reel: #${last.id} — ${last.status}${last.youtube_url ? ` — ${last.youtube_url}` : ''}`
      : 'No reels yet.',
  ].filter(Boolean);

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handleReel(interaction: ChatInputCommandInteraction): Promise<void> {
  // Belt and braces: these commands are not registered without an allowlist, but a
  // stale registration from an earlier config must not become an open door.
  if (config.discord.adminUserIds.length === 0 || !isOwner(interaction)) {
    await deny(interaction, 'You are not allowed to run that.');
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === 'build') {
    if (isRunning()) {
      await interaction.reply({
        content: 'A reel is already compiling.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: 'Building — this takes a while. I will post the link here.',
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
      await interaction.reply({
        content: 'No uploaded reel to publish.',
        flags: MessageFlags.Ephemeral,
      });
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
