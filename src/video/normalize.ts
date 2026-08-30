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
export async function normalizeClip(
  clip: ClipRow,
  index: number,
  /**
   * Where the reel will later cut this clip. Keyframes are placed there so the cut is
   * cheap and clean; the body is re-encoded regardless, so this is an optimisation
   * rather than a correctness requirement.
   */
  cutPoints: number[] = [],
): Promise<NormalizedClip> {
  const { width, height, maxClipSeconds } = config.video;
  if (!clip.file_path) throw new Error(`clip ${clip.id} has no downloaded file`);

  // Measured from the source's video stream, not the container. The container reports
  // the longest stream, so a clip whose audio runs past its picture would otherwise be
  // given a target the video cannot reach — and ffmpeg fills that gap by freezing the
  // last frame, which reads as a clip stalling and then cutting out.
  const source = await probe(clip.file_path);
  const requested = Math.min(source.videoDuration, maxClipSeconds);

  // Quantised to whole video frames, then forced onto BOTH streams below.
  //
  // Left alone, video length lands on a frame boundary while audio lands on an AAC
  // frame boundary that loudnorm has also lengthened, so each clip comes out with audio
  // tens of milliseconds longer than its video. xfade builds the video timeline from
  // video lengths and acrossfade builds the audio timeline from audio lengths, so those
  // per-clip differences accumulate: measured at +663ms of drift over twelve clips,
  // which is plainly audible by the end of a reel.
  // Floored, never rounded up: the target has to be reachable by frames that exist.
  const duration = Math.floor(requested * config.video.fps) / config.video.fps;
  const effective = requested;
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

  // Applied last so the label filter cannot shift the frame count. tpad is a safety
  // net for decode variance — with a floored target it should never clone a frame.
  videoChain.push(
    'tpad=stop_mode=clone:stop_duration=0.5',
    `trim=duration=${duration.toFixed(6)}`,
    'setpts=PTS-STARTPTS',
  );

  const audioChain = [
    // first_pts=0 pads the head with silence when a source's audio starts late, which
    // is the other half of keeping picture and sound aligned.
    'aresample=48000:async=1:first_pts=0',
    'aformat=sample_fmts=fltp:channel_layouts=stereo',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    // apad then atrim pins the audio to exactly `duration`: silence is added if
    // loudnorm came up short, and anything past the mark is cut.
    'apad',
    `atrim=duration=${duration.toFixed(6)}`,
    'asetpts=PTS-STARTPTS',
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

  const cuts = cutPoints.filter((t) => t > 0 && t < duration).map((t) => t.toFixed(3));
  if (cuts.length > 0) {
    args.splice(args.length - 1, 0, '-force_key_frames', cuts.join(','));
  }

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
