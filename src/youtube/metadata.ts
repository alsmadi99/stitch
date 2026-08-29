import { config } from '../config.js';
import type { Chapter } from '../video/compile.js';

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

/** YouTube only turns a timestamp list into chapters when every chapter is 10s or longer. */
const MIN_CHAPTER_SECONDS = 10;
const MIN_CHAPTER_COUNT = 3;
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;

export function buildTitle(sequence: number, clipCount: number, when = new Date()): string {
  const title = config.youtube.titleTemplate
    .replaceAll('{n}', String(sequence))
    .replaceAll('{count}', String(clipCount))
    .replaceAll('{month}', MONTHS[when.getMonth()] ?? '')
    .replaceAll('{year}', String(when.getFullYear()))
    .replaceAll('{date}', when.toISOString().slice(0, 10));

  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function chaptersAreValid(chapters: Chapter[], duration: number): boolean {
  if (chapters.length < MIN_CHAPTER_COUNT) return false;
  if ((chapters[0]?.start ?? 1) !== 0) return false;
  for (let i = 0; i < chapters.length; i++) {
    const end = chapters[i + 1]?.start ?? duration;
    if (end - chapters[i]!.start < MIN_CHAPTER_SECONDS) return false;
  }
  return true;
}

export function buildDescription(
  chapters: Chapter[],
  duration: number,
  contributors: { author_name: string; n: number }[],
): string {
  const parts: string[] = [
    `${chapters.length} clips from the community, all in one place.`,
    '',
  ];

  if (chaptersAreValid(chapters, duration)) {
    parts.push('Clips:');
    for (const c of chapters) parts.push(`${formatTimestamp(c.start)} ${c.authorName}`);
  } else {
    // Too short for real chapters — a plain credit list still gives people their name.
    parts.push('Clips in order:');
    parts.push(chapters.map((c) => c.authorName).join(' · '));
  }

  parts.push('', 'Contributors:');
  parts.push(
    contributors.map((c) => `${c.author_name} (${c.n} clip${c.n === 1 ? '' : 's'})`).join(', '),
  );
  parts.push('', 'Clipped and compiled automatically from our Discord.');

  const text = parts.join('\n');
  return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
}
