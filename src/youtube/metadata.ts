import { config } from '../config.js';
import { logger } from '../logger.js';

const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
/** YouTube ignores every hashtag on a video once there are more than 15. */
const MAX_HASHTAGS = 15;
/** Combined length of all tags, including the commas YouTube counts between them. */
const MAX_TAGS_LENGTH = 500;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function buildTitle(sequence: number, clipCount: number, when = new Date()): string {
  const title = config.youtube.titleTemplate
    .replaceAll('{n}', String(sequence))
    .replaceAll('{count}', String(clipCount))
    .replaceAll('{month}', MONTHS[when.getMonth()] ?? '')
    .replaceAll('{year}', String(when.getFullYear()))
    .replaceAll('{date}', when.toISOString().slice(0, 10));

  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

function countHashtags(text: string): number {
  return (text.match(/#\w+/g) ?? []).length;
}

/**
 * YouTube counts hashtags across the title *and* the description together, so the
 * `#7` in an episode title eats one of the 15 slots. Going over does not trim the
 * excess — it disables every hashtag on the video — so the title's share is reserved
 * before the list is laid out.
 */
function hashtagLine(title: string): string {
  const budget = Math.max(0, MAX_HASHTAGS - countHashtags(title));
  const tags = config.youtube.hashtags.map((t) => t.replace(/^#/, '').replace(/\s+/g, ''));

  if (tags.length > budget) {
    logger.warn(
      { given: tags.length, kept: budget, reservedByTitle: countHashtags(title) },
      'too many hashtags for the 15 slot budget — the list was truncated',
    );
  }

  return tags
    .slice(0, budget)
    .map((t) => `#${t}`)
    .join(' ');
}

/**
 * Generic series description — no per-clip breakdown and no contributor list, so the
 * same copy works for every episode. Set YOUTUBE_DESCRIPTION to replace it entirely.
 */
export function buildDescription(sequence: number, title: string): string {
  const body = config.youtube.description
    ? config.youtube.description.replaceAll('\\n', '\n').replaceAll('{n}', String(sequence))
    : [
        // No "#" before the episode number — it would spend one of the 15 hashtag slots.
        `Variety gaming clips from our Discord community — episode ${sequence}.`,
        '',
        `Games featured across the series: ${config.youtube.games.join(', ')} and more.`,
        '',
        'New episodes weekly.',
      ].join('\n');

  const text = `${body}\n\n${hashtagLine(title)}`;
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
}

/** Keeps adding tags until the 500-character budget runs out, rather than being rejected. */
export function buildTags(): string[] {
  const kept: string[] = [];
  let length = 0;

  for (const tag of config.youtube.tags) {
    const cost = tag.length + (kept.length > 0 ? 1 : 0);
    if (length + cost > MAX_TAGS_LENGTH) break;
    kept.push(tag);
    length += cost;
  }

  if (kept.length < config.youtube.tags.length) {
    logger.warn(
      { kept: kept.length, given: config.youtube.tags.length },
      'YOUTUBE_TAGS exceeds the 500 character budget — trailing tags dropped',
    );
  }

  return kept;
}
