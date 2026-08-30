import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { probe } from '../ingest/probe.js';
import type { ClipRow } from '../types.js';
import { encoderArgs, ffmpeg, threadArgs } from './ffmpeg.js';
import { normalizeClip, type NormalizedClip } from './normalize.js';
import { generateThumbnail } from './thumbnail.js';

export interface CompileResult {
  videoPath: string;
  thumbnailPath: string;
  duration: number;
  clipIds: number[];
}

/**
 * Joins normalized clips into one reel.
 *
 * Rather than handing ffmpeg two long files and asking it to blend at the end, the reel
 * is assembled from pieces:
 *
 *   body₀ · transition₀ · body₁ · transition₁ · … · bodyₙ
 *
 * Bodies are extracted with a stream copy — no decoding, no filters, no frame buffers.
 * Only the half-second transitions are re-encoded, from two half-second inputs. The
 * final assembly is a concat demuxer with `-c copy`.
 *
 * Peak memory therefore depends on the transition length, not the reel length. The
 * previous approach fed `xfade` two ~66 second segments with the crossfade at the very
 * end, and something in that arrangement buffered roughly the whole offset as decoded
 * frames: 2772MB measured, against 66s × 30fps × 1.4MB ≈ 2.8GB. No combination of batch
 * size or resolution avoided it, because the offset grows with the reel however the tree
 * is shaped. Here nothing ever holds more than a transition.
 *
 * Audio is built in one separate pass. Audio frames are kilobytes rather than megabytes,
 * so every clip can be open at once without the same risk, and keeping the track whole
 * avoids the frame-boundary gaps that cutting AAC losslessly would introduce.
 */
export async function compileReel(
  reelId: number,
  clips: ClipRow[],
  sequence: number,
): Promise<CompileResult> {
  if (clips.length === 0) throw new Error('nothing to compile');

  const log = logger.child({ reelId });
  const transition = planTransition(clips);

  log.info(
    {
      clips: clips.length,
      video: `${config.video.width}x${config.video.height}`,
      transition,
      threads: config.video.threads,
    },
    'normalizing clips',
  );

  // Cut points have to be known before encoding so keyframes can be forced there.
  const normalized: NormalizedClip[] = [];
  for (const [i, clip] of clips.entries()) {
    const target = Math.min(
      clip.duration ?? config.video.maxClipSeconds,
      config.video.maxClipSeconds,
    );
    const cuts = [i === 0 ? 0 : transition, i === clips.length - 1 ? 0 : target - transition];

    normalized.push(await normalizeClip(clip, i, cuts.filter((t) => t > 0)));
    log.debug({ done: i + 1, total: clips.length }, 'normalize progress');
  }

  const videoPath = path.join(config.paths.outDir, `reel-${reelId}.mp4`);

  if (normalized.length === 1) {
    await fsp.copyFile(normalized[0]!.file, videoPath);
  } else {
    const video = await assembleVideo(normalized, transition, reelId, log);
    const audioOnly = await assembleAudio(normalized, transition, video.offsets, reelId);
    await mux(video.file, audioOnly, videoPath);
    await Promise.all(
      [video.file, audioOnly].map((f) => fsp.rm(f, { force: true }).catch(() => undefined)),
    );
  }

  const duration = (await probe(videoPath)).duration;
  const thumbnailPath = await generateThumbnail(videoPath, duration, reelId, sequence);
  await cleanupWorkFiles(normalized);

  log.info({ duration: Math.round(duration), videoPath }, 'reel compiled');

  return { videoPath, thumbnailPath, duration, clipIds: normalized.map((c) => c.clipId) };
}

/**
 * Chosen before anything is encoded, because the keyframes forced during normalize
 * depend on it. A crossfade longer than half the shortest clip would swallow it whole.
 */
function planTransition(clips: ClipRow[]): number {
  const shortest = Math.min(
    ...clips.map((c) =>
      Math.min(c.duration ?? config.video.maxClipSeconds, config.video.maxClipSeconds),
    ),
  );
  const safe = Math.max(0.1, shortest / 2 - 0.1);
  const chosen = Math.min(config.video.transitionDuration, safe);

  if (chosen < config.video.transitionDuration) {
    logger.warn(
      { requested: config.video.transitionDuration, used: chosen, shortest },
      'shortened transition to fit the shortest clip',
    );
  }
  return Number(chosen.toFixed(3));
}

interface VideoAssembly {
  file: string;
  /** Where each clip's audio must be delayed to, in reel time. */
  offsets: number[];
}

/**
 * body₀ · transition₀ · body₁ · … assembled with a concat demuxer and no re-encoding.
 *
 * Every piece is measured after it is written rather than assumed. A `-c copy` cut can
 * only land on a keyframe, so a body's real duration drifts a little from the requested
 * one; building the soundtrack from the requested numbers instead put the audio four
 * seconds out by the end of a twenty clip reel. The offsets returned here are what the
 * video actually does.
 */
async function assembleVideo(
  clips: NormalizedClip[],
  transition: number,
  reelId: number,
  log: typeof logger,
): Promise<VideoAssembly> {
  const pieces: string[] = [];
  const offsets: number[] = [];
  let position = 0;

  for (const [i, clip] of clips.entries()) {
    const from = i === 0 ? 0 : transition;
    const to = i === clips.length - 1 ? clip.duration : clip.duration - transition;

    const body = await renderBody(
      clip.file,
      from,
      to,
      path.join(config.paths.workDir, `body-${reelId}-${i}.mp4`),
    );
    pieces.push(body);

    // This clip's audio starts `from` seconds into itself, and that instant lands here.
    offsets.push(Math.max(0, position - from));
    position += (await probe(body)).videoDuration;

    if (i < clips.length - 1) {
      const trans = await renderTransition(clip, clips[i + 1]!, transition, reelId, i);
      pieces.push(trans);
      position += (await probe(trans)).videoDuration;
    }
  }

  log.info({ pieces: pieces.length, transition, duration: Number(position.toFixed(2)) }, 'assembling video');

  const listFile = path.join(config.paths.workDir, `concat-${reelId}.txt`);
  const list = pieces.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fsp.writeFile(listFile, list, 'utf8');

  const out = path.join(config.paths.workDir, `video-${reelId}.mp4`);
  await ffmpeg(
    ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-an', out],
    { timeoutMs: 30 * 60_000 },
  );

  await Promise.all([...pieces, listFile].map((f) => fsp.rm(f, { force: true }).catch(() => undefined)));
  return { file: out, offsets };
}

/**
 * Cuts a clip's body, re-encoding it.
 *
 * A stream copy was tried first and is much cheaper, but `-c copy` can only cut on a
 * keyframe: each body came out slightly longer or shorter than asked for, and by the end
 * of a twenty clip reel the soundtrack was four seconds adrift. Re-encoding through the
 * `trim` filter is frame accurate, and it still only ever holds one input open, so peak
 * memory stays where it needs to be. The cost is one extra pass over the footage — half
 * of what the old tree spent, for an exact result.
 */
async function renderBody(input: string, from: number, to: number, out: string): Promise<string> {
  await ffmpeg([
    '-y',
    ...threadArgs(),
    '-i',
    input,
    '-vf',
    `trim=start=${from.toFixed(3)}:end=${to.toFixed(3)},setpts=PTS-STARTPTS`,
    '-an',
    ...encoderArgs(),
    out,
  ]);
  return out;
}

/**
 * The only re-encode in a join: two half-second inputs blended into one half-second
 * output. `offset=0` starts the crossfade immediately, so the result is exactly
 * `transition` long.
 */
async function renderTransition(
  a: NormalizedClip,
  b: NormalizedClip,
  transition: number,
  reelId: number,
  index: number,
): Promise<string> {
  const name = config.video.transitions[index % config.video.transitions.length] ?? 'fade';
  const out = path.join(config.paths.workDir, `trans-${reelId}-${index}.mp4`);
  const t = transition.toFixed(3);

  await ffmpeg([
    '-y',
    ...threadArgs(),
    '-ss',
    (a.duration - transition).toFixed(3),
    '-i',
    a.file,
    '-t',
    t,
    '-i',
    b.file,
    '-filter_complex',
    `[0:v][1:v]xfade=transition=${name}:duration=${t}:offset=0[v]`,
    '-map',
    '[v]',
    '-an',
    ...encoderArgs(),
    out,
  ]);

  return out;
}

/**
 * The whole soundtrack in one pass: each clip faded and placed at the offset its video
 * occupies, then summed. Audio frames are small enough that holding every clip open
 * costs little, and doing it in one pass avoids both the accumulating drift of chained
 * `acrossfade` and the gaps that cutting AAC on non-frame boundaries would leave.
 */
async function assembleAudio(
  clips: NormalizedClip[],
  transition: number,
  offsets: number[],
  reelId: number,
): Promise<string> {
  const args: string[] = ['-y', ...threadArgs()];
  for (const clip of clips) args.push('-i', clip.file);

  const filters: string[] = [];
  const labels: string[] = [];
  const t = transition.toFixed(3);

  for (const [k, clip] of clips.entries()) {
    const steps: string[] = [];
    if (k > 0) steps.push(`afade=t=in:st=0:d=${t}`);
    if (k < clips.length - 1) {
      steps.push(`afade=t=out:st=${(clip.duration - transition).toFixed(3)}:d=${t}`);
    }

    // Taken from the assembled video, not from the intended arithmetic.
    const delayMs = Math.round((offsets[k] ?? 0) * 1000);
    if (delayMs > 0) steps.push(`adelay=${delayMs}:all=1`);
    if (steps.length === 0) steps.push('anull');

    filters.push(`[${k}:a]${steps.join(',')}[a${k}]`);
    labels.push(`[a${k}]`);
  }

  filters.push(`${labels.join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[a]`);

  const out = path.join(config.paths.workDir, `audio-${reelId}.m4a`);
  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[a]',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    out,
  );

  await ffmpeg(args, { timeoutMs: 30 * 60_000 });
  return out;
}

/** Both tracks are already in their final form, so this only rewraps them. */
async function mux(video: string, audio: string, out: string): Promise<void> {
  await ffmpeg([
    '-y',
    '-i',
    video,
    '-i',
    audio,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-shortest',
    '-movflags',
    '+faststart',
    out,
  ]);
}

/**
 * Deletes normalize and assembly intermediates left behind by a killed process. They are
 * only ever inputs to a compile that is already over, so a few interrupted runs would
 * otherwise quietly fill the volume.
 */
export async function cleanStaleWorkFiles(): Promise<number> {
  const entries = await fsp.readdir(config.paths.workDir).catch(() => []);
  const stale = entries.filter((f) =>
    /^(norm-|stitch-|body-|trans-|concat-|video-|audio-|label-|thumb-)/.test(f),
  );

  await Promise.all(
    stale.map((f) => fsp.rm(path.join(config.paths.workDir, f), { force: true }).catch(() => undefined)),
  );

  if (stale.length > 0) logger.warn({ files: stale.length }, 'removed stale work files');
  return stale.length;
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
