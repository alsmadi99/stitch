import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { probe } from '../ingest/probe.js';
import type { ClipRow } from '../types.js';
import { encoderArgs, ffmpeg, ffprobe, threadArgs } from './ffmpeg.js';
import { normalizeClip, type NormalizedClip } from './normalize.js';
import { generateThumbnail } from './thumbnail.js';

/**
 * Deletes normalize and stitch intermediates left behind by a killed process. They are
 * only ever inputs to a compile that is already over, and at 1080p each one is tens of
 * megabytes, so a few interrupted runs quietly fill the volume.
 */
export async function cleanStaleWorkFiles(): Promise<number> {
  const entries = await fsp.readdir(config.paths.workDir).catch(() => []);
  const stale = entries.filter((f) => /^(norm-|stitch-|label-|thumb-)/.test(f));

  await Promise.all(
    stale.map((f) => fsp.rm(path.join(config.paths.workDir, f), { force: true }).catch(() => undefined)),
  );

  if (stale.length > 0) logger.warn({ files: stale.length }, 'removed stale work files');
  return stale.length;
}

/**
 * Intermediate stitch levels are deleted as soon as the next level consumes them, so
 * they are tuned for speed, not size: a fast preset and a high-quality CRF. Only the
 * final pass uses the configured preset and CRF.
 */
const INTERMEDIATE_CRF = 16;
const INTERMEDIATE_PRESET = 'ultrafast';

export interface CompileResult {
  videoPath: string;
  thumbnailPath: string;
  duration: number;
  clipIds: number[];
}

/** A piece of the reel — one normalized clip, or several already stitched together. */
interface Segment {
  file: string;
  duration: number;
  /** How many source clips it contains, used only to keep transitions varied. */
  clips: number;
  /** Intermediate files get deleted; normalized inputs are cleaned up separately. */
  temporary: boolean;
}

/**
 * Normalizes every clip, then stitches them with a crossfade between each pair.
 *
 * Stitching happens in small batches rather than one ffmpeg call per reel. A single
 * call with 20 inputs keeps 20 decoders and their frame buffers alive at once, which
 * runs to well over a gigabyte at 1080p — enough to get the process OOM-killed on a
 * small VPS. Folding `STITCH_BATCH` segments at a time caps peak memory at roughly
 * that many decoders, at the cost of one extra encode pass per tree level.
 */
export async function compileReel(
  reelId: number,
  clips: ClipRow[],
  sequence: number,
): Promise<CompileResult> {
  if (clips.length === 0) throw new Error('nothing to compile');

  const log = logger.child({ reelId });
  log.info(
    {
      clips: clips.length,
      video: `${config.video.width}x${config.video.height}`,
      stitchBatch: config.video.stitchBatch,
      threads: config.video.threads,
    },
    'normalizing clips',
  );

  const normalized: NormalizedClip[] = [];
  for (const [i, clip] of clips.entries()) {
    normalized.push(await normalizeClip(clip, i));
    log.debug({ done: i + 1, total: clips.length }, 'normalize progress');
  }

  const videoPath = path.join(config.paths.outDir, `reel-${reelId}.mp4`);
  const transition = pickTransitionDuration(normalized);

  let segments: Segment[] = normalized.map((c) => ({
    file: c.file,
    duration: c.duration,
    clips: 1,
    temporary: false,
  }));

  let level = 0;
  while (segments.length > 1) {
    const batches = chunk(segments, config.video.stitchBatch);
    log.info(
      {
        level,
        segments: segments.length,
        batches: batches.length,
        inputsPerBatch: Math.min(config.video.stitchBatch, segments.length),
      },
      'stitching',
    );

    // The last level produces the file that ships, so it gets the configured quality.
    const isFinalLevel = batches.length === 1;
    const crf = isFinalLevel ? config.video.crf : INTERMEDIATE_CRF;
    const preset = isFinalLevel ? config.video.preset : INTERMEDIATE_PRESET;
    const next: Segment[] = [];
    for (const [i, batch] of batches.entries()) {
      next.push(await stitchBatch(batch, transition, reelId, level, i, crf, preset));
    }

    // A batch of one is passed straight through, so that file is still live at the next
    // level. Deleting it as part of "the previous level" would pull the input out from
    // under the very next ffmpeg call.
    const carried = new Set(next.map((s) => s.file));
    await removeTemporary(segments.filter((s) => !carried.has(s.file)));

    segments = next;
    level++;
  }

  const final = segments[0]!;
  await fsp.rename(final.file, videoPath).catch(async () => {
    // rename fails across devices; fall back to a copy.
    await fsp.copyFile(final.file, videoPath);
    await fsp.rm(final.file, { force: true });
  });

  // Measured rather than predicted: every encode pass can drift by a frame or two.
  const duration = (await probe(videoPath)).duration;

  const thumbnailPath = await generateThumbnail(videoPath, duration, reelId, sequence);
  await cleanupWorkFiles(normalized);

  log.info({ duration: Math.round(duration), levels: level, videoPath }, 'reel compiled');

  return { videoPath, thumbnailPath, duration, clipIds: normalized.map((c) => c.clipId) };
}

/**
 * Duration, frame count and size of a stitch input, for the log line above.
 *
 * Cheap enough to run per segment, and the only way to identify a malformed
 * intermediate after a kill: when `impliedFps` diverges from the declared frame rate,
 * the file's timestamps disagree with its content, and that is the kind of input that
 * makes a rate converter allocate without bound.
 */
async function inspect(file: string): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await ffprobe(['-print_format', 'json', '-show_streams', '-show_format', file]);
    const data = JSON.parse(stdout.toString()) as {
      streams: { codec_type: string; nb_frames?: string; avg_frame_rate?: string }[];
      format: { duration?: string; size?: string };
    };
    const video = data.streams.find((v) => v.codec_type === 'video');
    const seconds = Number(data.format.duration ?? 0);
    const frames = Number(video?.nb_frames ?? 0);

    return {
      seconds: Number(seconds.toFixed(2)),
      frames,
      fps: video?.avg_frame_rate,
      impliedFps: seconds > 0 ? Number((frames / seconds).toFixed(1)) : null,
      sizeMb: Math.round(Number(data.format.size ?? 0) / 1_048_576),
    };
  } catch {
    return { probe: 'failed' };
  }
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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Joins one batch into a single file. A batch of one is passed through untouched so a
 * leftover segment never picks up a pointless extra encode.
 */
async function stitchBatch(
  batch: Segment[],
  transition: number,
  reelId: number,
  level: number,
  index: number,
  crf: number,
  preset: string,
): Promise<Segment> {
  if (batch.length === 1) return batch[0]!;

  const out = path.join(config.paths.workDir, `stitch-${reelId}-l${level}-${index}.mp4`);

  // Logged before the call so a kill leaves evidence of what it was fed. A segment whose
  // frame count does not match its duration is the signature of a timestamp anomaly,
  // which is the kind of input that makes a filter allocate without bound.
  for (const segment of batch) {
    const stats = await inspect(segment.file);
    logger.info({ file: path.basename(segment.file), ...stats }, 'stitch input');
  }

  await ffmpeg(buildStitchArgs(batch, transition, out, crf, preset), { timeoutMs: 60 * 60_000 });

  return {
    file: out,
    duration: (await probe(out)).duration,
    clips: batch.reduce((n, s) => n + s.clips, 0),
    temporary: true,
  };
}

/**
 * Builds one stitch call: xfade for picture, and for sound an explicit timeline rather
 * than acrossfade.
 *
 * acrossfade chained across a batch produces an audio timeline about 1024 samples
 * (~21ms at 48kHz) shorter per join than the video timeline xfade produces from the
 * same durations. Measured with flash-and-beep markers, that compounded to 323ms of
 * audio-ahead drift over twelve clips — inaudible at the first join, obvious by the
 * last. Placing every segment's audio at the same offset the video uses makes the two
 * agree by construction instead of by coincidence.
 */
function buildStitchArgs(
  segments: Segment[],
  transition: number,
  out: string,
  crf: number,
  preset: string,
): string[] {
  const args: string[] = ['-y', ...threadArgs()];
  for (const segment of segments) args.push('-i', segment.file);

  const filters: string[] = [];
  const t = transition.toFixed(3);

  // --- video: chained crossfades ---
  let videoLabel = '0:v';
  let elapsed = segments[0]!.duration;
  // Keep transition variety walking across the whole reel rather than resetting inside
  // every batch.
  let joinIndex = segments[0]!.clips - 1;

  for (let k = 1; k < segments.length; k++) {
    const name = config.video.transitions[joinIndex % config.video.transitions.length] ?? 'fade';
    filters.push(
      `[${videoLabel}][${k}:v]xfade=transition=${name}:duration=${t}:offset=${(elapsed - transition).toFixed(3)}[v${k}]`,
    );
    videoLabel = `v${k}`;
    elapsed += segments[k]!.duration - transition;
    joinIndex += segments[k]!.clips;
  }

  // --- audio: same offsets, laid out independently and summed ---
  const audioLabels: string[] = [];
  let start = 0;

  for (const [k, segment] of segments.entries()) {
    const steps: string[] = [];
    if (k > 0) steps.push(`afade=t=in:st=0:d=${t}`);
    if (k < segments.length - 1) {
      steps.push(`afade=t=out:st=${(segment.duration - transition).toFixed(3)}:d=${t}`);
    }

    const delayMs = Math.round(start * 1000);
    if (delayMs > 0) steps.push(`adelay=${delayMs}:all=1`);
    if (steps.length === 0) steps.push('anull');

    filters.push(`[${k}:a]${steps.join(',')}[fa${k}]`);
    audioLabels.push(`[fa${k}]`);
    start += segment.duration - transition;
  }

  // normalize=0 keeps levels intact; the linear fade pair sums to unity across the
  // overlap, so a crossfade neither dips nor clips.
  filters.push(
    `${audioLabels.join('')}amix=inputs=${segments.length}:normalize=0:dropout_transition=0[a]`,
  );

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoLabel}]`,
    '-map',
    '[a]',
    ...encoderArgs(crf, preset),
    out,
  );

  return args;
}

async function removeTemporary(segments: Segment[]): Promise<void> {
  await Promise.all(
    segments
      .filter((s) => s.temporary)
      .map((s) => fsp.rm(s.file, { force: true }).catch(() => undefined)),
  );
}

async function cleanupWorkFiles(clips: NormalizedClip[]): Promise<void> {
  await Promise.all(
    clips.flatMap((c) => [
      fsp.rm(c.file, { force: true }).catch(() => undefined),
      fsp
        .rm(path.join(config.paths.workDir, `label-${c.clipId}.txt`), { force: true })
        .catch(() => undefined),
    ]),
  );
}
