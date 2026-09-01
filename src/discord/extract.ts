import type { Message } from 'discord.js';
import { config } from '../config.js';
import type { Candidate } from '../types.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v', '.avi']);

/**
 * Hosts yt-dlp handles well and that people actually post clips from. Deliberately
 * excludes image hosts like imgur — a link there is far more often a screenshot, and
 * every one would cost a download and a probe before being thrown away.
 */
const LINK_HOSTS = [
  'medal.tv',
  'streamable.com',
  'clips.twitch.tv',
  'twitch.tv',
  'youtube.com',
  'youtu.be',
  'outplayed.tv',
];

const URL_RE = /https?:\/\/[^\s<>|]+/gi;

function isSupportedHost(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    return LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Images, screenshots, text files and everything else in the channel are ignored here,
 * before anything is downloaded. Discord reports a content type for most uploads; the
 * extension check is the fallback for the ones it does not.
 */
function looksLikeVideoAttachment(name: string, contentType: string | null): boolean {
  if (contentType) return contentType.startsWith('video/');
  const dot = name.lastIndexOf('.');
  return dot !== -1 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * Everything clip-shaped in a message: uploaded video files first, then links to
 * clip hosts. Bots and the channel filter are handled by the caller.
 */
export function extractCandidates(message: Message): Candidate[] {
  const base = {
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
    messageAt: message.createdAt,
  };

  const out: Candidate[] = [];

  for (const attachment of message.attachments.values()) {
    if (looksLikeVideoAttachment(attachment.name, attachment.contentType)) {
      out.push({ ...base, sourceType: 'attachment', sourceUrl: attachment.url });
    }
  }

  // A link is fetched from a third-party site on the poster's say-so, which is a bigger
  // lever than attaching a file. An empty allowlist keeps the old behaviour: anyone.
  const allowed = config.ingest.linkAllowedUserIds;
  const mayPostLinks = allowed.length === 0 || allowed.includes(message.author.id);

  if (config.ingest.allowLinks && mayPostLinks) {
    const seen = new Set<string>();
    const texts = [message.content, ...message.embeds.map((e) => e.url ?? '')];
    for (const text of texts) {
      for (const match of text.match(URL_RE) ?? []) {
        const url = match.replace(/[),.]+$/, '');
        if (seen.has(url) || !isSupportedHost(url)) continue;
        seen.add(url);
        out.push({ ...base, sourceType: 'link', sourceUrl: url });
      }
    }
  }

  return out;
}
