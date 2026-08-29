import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { probe } from '../ingest/probe.js';
import type { ClipRow } from '../types.js';
import { canDrawText, encoderArgs, escapeFilterPath, ffmpeg, resolveFont, threadArgs } from './ffmpeg.js';

export interface NormalizedClip {
  clipId: number;
  file: string;
  /** Exact duration of the normalized file — xfade offsets depend on it. */
  duration: number;
}

/**
 * Re-encodes one clip to the reel's common format: fixed resolution (letterboxed,
 * never stretched), fixed frame rate, stereo 48kHz audio at a uniform loudness, and
 * a silent track synthesised when the source has none. xfade requires every input to
 * match, and loudnorm is what stops one screaming clip from blowing out the mix.
 */
export async function normalizeClip(clip: ClipRow, index: number): Promise<NormalizedClip> {
  const { width, height, maxClipSeconds } = config.video;
  if (!clip.file_path) throw new Error(`clip ${clip.id} has no downloaded file`);

  const effective = Math.min(clip.duration ?? maxClipSeconds, maxClipSeconds);
  const out = path.join(config.paths.workDir, `norm-${String(index).padStart(3, '0')}-${clip.id}.mp4`);

  const videoChain = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${config.video.fps}`,
    'setsar=1',
    'format=yuv420p',
  ];

  const label = await buildLabelFilter(clip, height);
  if (label) videoChain.push(label);

  const audioChain = [
    'aresample=48000:async=1',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ];

  const args: string[] = ['-y', ...threadArgs(), '-t', effective.toFixed(3), '-i', clip.file_path];

  if (!clip.has_audio) {
    args.push('-f', 'lavfi', '-t', effective.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  const audioInput = clip.has_audio ? '0:a' : '1:a';

  args.push(
    '-filter_complex',
    `[0:v]${videoChain.join(',')}[v];[${audioInput}]${audioChain.join(',')}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...encoderArgs(),
    out,
  );

  await ffmpeg(args, { timeoutMs: 10 * 60_000 });

  // loudnorm and frame-rate conversion can shift the length by a few frames, and the
  // transition offsets are computed from these numbers, so re-measure rather than assume.
  const meta = await probe(out);
  logger.debug({ clipId: clip.id, duration: meta.duration }, 'normalized');

  return { clipId: clip.id, file: out, duration: meta.duration };
}

/**
 * Credit overlay for the first few seconds. The name goes through a text file so no
 * amount of punctuation in a Discord display name can break the filtergraph.
 */
async function buildLabelFilter(clip: ClipRow, height: number): Promise<string | null> {
  if (!config.video.titleCards) return null;
  if (!(await canDrawText(config.video.fontFile))) return null;

  const font = resolveFont(config.video.fontFile);
  if (!font) return null;

  const labelFile = path.join(config.paths.workDir, `label-${clip.id}.txt`);
  await fsp.writeFile(labelFile, `@${clip.author_name}`, 'utf8');

  const fontSize = Math.round(height / 22);
  return [
    'drawtext=',
    `fontfile='${escapeFilterPath(font)}'`,
    `:textfile='${escapeFilterPath(labelFile)}'`,
    ':fontcolor=white',
    `:fontsize=${fontSize}`,
    ':box=1:boxcolor=black@0.5',
    `:boxborderw=${Math.round(fontSize / 2)}`,
    `:x=${Math.round(height / 20)}`,
    `:y=h-th-${Math.round(height / 12)}`,
    `:enable='lt(t,${config.video.titleCardSeconds})'`,
  ].join('');
}
