/**
 * Checks every integration point and reports what is still missing.
 * Read-only: it never posts a message, uploads a video, or changes a setting.
 *
 * Usage: npm run doctor
 */
import { PermissionFlagsBits, type Guild, type GuildBasedChannel } from 'discord.js';
import type { OAuth2Client } from 'google-auth-library';
import type { Config } from '../src/config.js';

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  level: Level;
  detail: string;
}

const checks: Check[] = [];
const add = (name: string, level: Level, detail: string) => checks.push({ name, level, detail });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which Google account the refresh token belongs to. Only available when the token
 * carries the userinfo.email scope, so tokens minted before that scope was added
 * simply report nothing rather than failing the check.
 */
async function authorizedEmail(client: OAuth2Client): Promise<string | null> {
  try {
    const { token } = await client.getAccessToken();
    if (!token) return null;
    const info = await client.getTokenInfo(token);
    return info.email ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- environment

let config: Config;

try {
  ({ config } = await import('../src/config.js'));
  add('env file', 'ok', 'loaded and valid');
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}

// ---------------------------------------------------------------- binaries

try {
  const { ffmpeg, ffprobe, FFMPEG } = await import('../src/video/ffmpeg.js');
  await ffmpeg(['-version']);
  await ffprobe(['-version']);
  add('ffmpeg / ffprobe', 'ok', FFMPEG.includes('ffmpeg-static') ? 'bundled binaries' : FFMPEG);
} catch (err) {
  add('ffmpeg / ffprobe', 'fail', errorMessage(err));
}

if (config.ingest.allowLinks) {
  const { hasYtDlp } = await import('../src/ingest/download.js');
  add(
    'yt-dlp',
    (await hasYtDlp()) ? 'ok' : 'warn',
    (await hasYtDlp()) ? 'on PATH' : 'missing — link clips will be skipped, attachments still work',
  );
} else {
  add('yt-dlp', 'ok', 'not needed (ALLOW_LINKS=false)');
}

// ---------------------------------------------------------------- database

try {
  const { countPending } = await import('../src/db/clips.js');
  add('sqlite', 'ok', `${countPending()} clips queued at ${config.paths.dbFile}`);
} catch (err) {
  add('sqlite', 'fail', errorMessage(err));
}

// ---------------------------------------------------------------- discord

const { client, login } = await import('../src/discord/client.js');

const REQUIRED_CHANNEL_PERMS = [
  ['View Channel', PermissionFlagsBits.ViewChannel],
  ['Send Messages', PermissionFlagsBits.SendMessages],
  ['Embed Links', PermissionFlagsBits.EmbedLinks],
  ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
  ['Add Reactions', PermissionFlagsBits.AddReactions],
] as const;

function checkChannel(label: string, channel: GuildBasedChannel, guild: Guild): void {
  const me = guild.members.me;
  if (!me) {
    add(label, 'fail', 'bot is not a member of that guild');
    return;
  }

  const perms = channel.permissionsFor(me);
  const missing = REQUIRED_CHANNEL_PERMS.filter(([, flag]) => !perms?.has(flag)).map(([n]) => n);

  if (missing.length > 0) add(label, 'fail', `#${channel.name} — missing: ${missing.join(', ')}`);
  else add(label, 'ok', `#${channel.name} in ${guild.name}`);
}

try {
  await login();
  add('discord login', 'ok', `connected as ${client.user?.tag}`);

  // Message Content is privileged and silently yields empty attachments when off.
  const app = await client.application?.fetch();
  const intentsOk = Boolean(app?.flags.has('GatewayMessageContent') || app?.flags.has('GatewayMessageContentLimited'));
  add(
    'message content intent',
    intentsOk ? 'ok' : 'fail',
    intentsOk
      ? 'enabled'
      : 'DISABLED — turn on "Message Content Intent" in the Developer Portal or nothing is collected',
  );

  const clipsChannel = await client.channels.fetch(config.discord.clipsChannelId).catch(() => null);
  if (!clipsChannel || !('guild' in clipsChannel)) {
    add('clips channel', 'fail', `cannot see channel ${config.discord.clipsChannelId}`);
  } else {
    checkChannel('clips channel', clipsChannel, clipsChannel.guild);
  }

  if (config.discord.announceChannelId !== config.discord.clipsChannelId) {
    const announce = await client.channels.fetch(config.discord.announceChannelId).catch(() => null);
    if (!announce || !('guild' in announce)) {
      add('announce channel', 'fail', `cannot see channel ${config.discord.announceChannelId}`);
    } else {
      checkChannel('announce channel', announce, announce.guild);
    }
  }

  if (config.discord.guildId) {
    const guild = await client.guilds.fetch(config.discord.guildId).catch(() => null);
    add(
      'guild id',
      guild ? 'ok' : 'fail',
      guild ? `${guild.name} — slash commands register instantly` : 'bot is not in that guild',
    );
  } else {
    add('guild id', 'warn', 'blank — slash commands register globally and take up to an hour');
  }
} catch (err) {
  add('discord login', 'fail', errorMessage(err));
}

// ---------------------------------------------------------------- youtube

if (!config.youtube.enabled) {
  const missing = [
    !config.youtube.clientId && 'YOUTUBE_CLIENT_ID',
    !config.youtube.clientSecret && 'YOUTUBE_CLIENT_SECRET',
    !config.youtube.refreshToken && 'YOUTUBE_REFRESH_TOKEN',
  ].filter(Boolean);
  add('youtube', 'warn', `local-only mode — missing ${missing.join(', ')}`);
} else {
  try {
    const { authorizedClient, youtubeClient } = await import('../src/youtube/auth.js');
    const res = await youtubeClient().channels.list({ part: ['snippet', 'status'], mine: true });
    const channel = res.data.items?.[0];
    if (!channel) {
      const who = await authorizedEmail(await authorizedClient());
      add(
        'youtube',
        'fail',
        `${who ?? 'that Google account'} has no YouTube channel attached to this token. ` +
          'Either create a channel at youtube.com signed in as it, or — if your channel is a ' +
          'Brand Account — re-run `npm run youtube:auth` and pick the channel, not the personal account.',
      );
    } else {
      const who = await authorizedEmail(await authorizedClient());
      add(
        'youtube',
        'ok',
        `uploading to "${channel.snippet?.title}"${who ? ` (${who})` : ''} as ${config.youtube.privacy}`,
      );
      // A channel flagged as made-for-kids has personalised ads disabled on every
      // upload, which is the usual reason monetization silently never turns on.
      if (channel.status?.madeForKids) {
        add('youtube audience', 'warn', 'channel is set to "made for kids" — that disables monetization on every upload');
      }

      // 20 clips at the default 60s cap is a 20 minute video; unverified channels are
      // capped at 15 minutes and the upload fails outright.
      const longUploads = channel.status?.longUploadsStatus;
      if (longUploads !== 'allowed') {
        const maxReel = (config.trigger.maxClips * config.video.maxClipSeconds) / 60;
        add(
          'youtube long uploads',
          maxReel > 15 ? 'fail' : 'warn',
          `longUploadsStatus=${longUploads ?? 'unknown'} — videos over 15 minutes are rejected, and this config can produce ${Math.round(maxReel)} minutes. Verify the channel at youtube.com/verify.`,
        );
      }
    }
  } catch (err) {
    add('youtube', 'fail', errorMessage(err));
  }
}

// ---------------------------------------------------------------- metadata

{
  const { buildTitle, buildDescription, buildTags } = await import('../src/youtube/metadata.js');
  const sequence = (await import('../src/db/reels.js')).completedReelCount() + 1;
  const title = buildTitle(sequence, config.trigger.maxClips);

  if (config.youtube.titleTemplate.includes('{n}')) {
    add('title template', 'ok', title);
  } else {
    // Almost always dotenv eating `#{n}` as a comment in an unquoted .env value.
    add(
      'title template',
      'warn',
      `no {n} in YOUTUBE_TITLE_TEMPLATE — the thumbnail shows #${sequence} but the title will not. ` +
        'If your template contains a #, wrap the whole value in double quotes in .env.',
    );
  }

  const hashtagCount = (buildDescription(sequence, title).match(/#\w+/g) ?? []).length;
  const titleTags = (title.match(/#\w+/g) ?? []).length;
  add(
    'description',
    hashtagCount + titleTags > 15 ? 'fail' : 'ok',
    `${hashtagCount} hashtags in the description + ${titleTags} in the title (limit 15 combined), ${buildTags().length} tags`,
  );
}

// ---------------------------------------------------------------- report

const icon: Record<Level, string> = { ok: 'PASS', warn: 'WARN', fail: 'FAIL' };
console.log('');
for (const c of checks) console.log(`${icon[c.level].padEnd(5)} ${c.name.padEnd(24)} ${c.detail}`);

const failed = checks.filter((c) => c.level === 'fail').length;
const warned = checks.filter((c) => c.level === 'warn').length;
console.log(`\n${checks.length - failed - warned} passed, ${warned} warnings, ${failed} failures\n`);

await client.destroy().catch(() => undefined);
process.exit(failed > 0 ? 1 : 0);
