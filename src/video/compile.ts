import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { ClipRow } from '../types.js';
import { ffmpeg } from './ffmpeg.js';
import { normalizeClip, type NormalizedClip } from './normalize.js';

export interface Chapter {
  clipId: number;
  authorName: string;
  /** Seconds from the start of the reel. */
  start: number;
}

export interface CompileResult {
  videoPath: string;
  thumbnailPath: string;
  duration: number;
  clipIds: number[];
  chapters: Chapter[];
}

/**
 * Normalizes every clip, then stitches them with a crossfade between each pair.
 *
 * xfade overlaps the two inputs, so joining N clips yields
 * `sum(durations) - (N - 1) * transition` seconds, and the offset for the k-th join is
 * `sum(durations[0..k-1]) - k * transition`.
 */
export async function compileReel(reelId: number, clips: ClipRow[]): Promise<CompileResult> {
  if (clips.length === 0) throw new Error('nothing to compile');

  const log = logger.child({ reelId });
  log.info({ clips: clips.length }, 'normalizing clips');

  const normalized: NormalizedClip[] = [];
  for (const [i, clip] of clips.entries()) {
    normalized.push(await normalizeClip(clip, i));
    log.debug({ done: i + 1, total: clips.length }, 'normalize progress');
  }

  const videoPath = path.join(config.paths.outDir, `reel-${reelId}.mp4`);
  const transition = pickTransitionDuration(normalized);

  if (normalized.length === 1) {
    await fsp.copyFile(normalized[0]!.file, videoPath);
  } else {
    await ffmpeg(buildStitchArgs(normalized, transition, videoPath), { timeoutMs: 60 * 60_000 });
  }

  const duration =
    normalized.reduce((sum, c) => sum + c.duration, 0) - (normalized.length - 1) * transition;

  const thumbnailPath = await grabThumbnail(videoPath, reelId, duration);
  const chapters = buildChapters(normalized, clips, transition);
  await cleanupWorkFiles(normalized);

  log.info({ duration: Math.round(duration), videoPath }, 'reel compiled');

  return {
    videoPath,
    thumbnailPath,
    duration,
    clipIds: normalized.map((c) => c.clipId),
    chapters,
  };
}

/** Where each clip lands in the finished reel — same arithmetic as the xfade offsets. */
function buildChapters(
  normalized: NormalizedClip[],
  clips: ClipRow[],
  transition: number,
): Chapter[] {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const chapters: Chapter[] = [];
  let start = 0;

  for (const [k, clip] of normalized.entries()) {
    chapters.push({
      clipId: clip.clipId,
      authorName: byId.get(clip.clipId)?.author_name ?? 'unknown',
      start: k === 0 ? 0 : start,
    });
    start += clip.duration - transition;
  }

  return chapters;
}

/** A crossfade longer than half the shortest clip would swallow it whole. */
function pickTransitionDuration(clips: NormalizedClip[]): number {
  const shortest = Math.min(...clips.map((c) => c.duration));
  const safe = Math.max(0.1, shortest / 2 - 0.1);
  const chosen = Math.min(config.video.transitionDuration, safe);
  if (chosen < config.video.transitionDuration) {
    logger.warn(
      { requested: config.video.transitionDuration, used: chosen, shortest },
      'shortened transition to fit the shortest clip',
    );
  }
  return chosen;
}

function buildStitchArgs(clips: NormalizedClip[], transition: number, out: string): string[] {
  const args: string[] = ['-y'];
  for (const clip of clips) args.push('-i', clip.file);

  const filters: string[] = [];
  let videoLabel = '0:v';
  let audioLabel = '0:a';
  let elapsed = clips[0]!.duration;

  for (let k = 1; k < clips.length; k++) {
    const offset = elapsed - transition;
    const name = config.video.transitions[(k - 1) % config.video.transitions.length] ?? 'fade';
    const nextV = `v${k}`;
    const nextA = `a${k}`;

    filters.push(
      `[${videoLabel}][${k}:v]xfade=transition=${name}:duration=${transition.toFixed(3)}:offset=${offset.toFixed(3)}[${nextV}]`,
      `[${audioLabel}][${k}:a]acrossfade=d=${transition.toFixed(3)}:c1=tri:c2=tri[${nextA}]`,
    );

    videoLabel = nextV;
    audioLabel = nextA;
    elapsed += clips[k]!.duration - transition;
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoLabel}]`,
    '-map',
    `[${audioLabel}]`,
    '-c:v',
    'libx264',
    '-preset',
    config.video.preset,
    '-crf',
    String(config.video.crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(config.video.fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    out,
  );

  return args;
}

async function grabThumbnail(video: string, reelId: number, duration: number): Promise<string> {
  const out = path.join(config.paths.outDir, `reel-${reelId}.jpg`);
  await ffmpeg([
    '-y',
    '-ss',
    Math.max(0, duration * 0.35).toFixed(2),
    '-i',
    video,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    out,
  ]);
  return out;
}

async function cleanupWorkFiles(clips: NormalizedClip[]): Promise<void> {
  await Promise.all(
    clips.flatMap((c) => [
      fsp.rm(c.file, { force: true }).catch(() => undefined),
      fsp.rm(path.join(config.paths.workDir, `label-${c.clipId}.txt`), { force: true }).catch(() => undefined),
    ]),
  );
}
