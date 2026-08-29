import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { canDrawText, escapeFilterPath, ffmpeg, resolveFont, threadArgs } from './ffmpeg.js';

const WIDTH = 1280;
const HEIGHT = 720;
/** Frames sampled from the finished reel when picking the background. */
const CANDIDATES = 24;
/** Size of the thumbnails used for scoring — big enough to judge, cheap to decode. */
const SCORE_W = 32;
const SCORE_H = 18;

/**
 * Builds the episode thumbnail: the most eye-catching frame in the reel, graded, with
 * a consistent badge and label burned on so every episode in the playlist matches.
 * Falls back to a plain frame grab when no usable font is installed.
 */
export async function generateThumbnail(
  video: string,
  duration: number,
  reelId: number,
  sequence: number,
): Promise<string> {
  const out = path.join(config.paths.outDir, `reel-${reelId}.jpg`);
  const timestamp = await pickBestFrame(video, duration);
  const font = (await canDrawText(config.video.fontFile)) ? resolveFont(config.video.fontFile) : null;

  // A missing font or a drawtext-less ffmpeg build costs the labels, never the reel.
  if (!font) {
    logger.warn('cannot burn text — falling back to a plain graded frame for the thumbnail');
    await ffmpeg([
      '-y',
      ...threadArgs(),
      '-ss',
      timestamp.toFixed(2),
      '-i',
      video,
      '-frames:v',
      '1',
      '-vf',
      `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},eq=saturation=1.25:contrast=1.08,vignette=PI/5`,
      '-q:v',
      '3',
      out,
    ]);
    return out;
  }

  const labelFile = path.join(config.paths.workDir, `thumb-label-${reelId}.txt`);
  const badgeFile = path.join(config.paths.workDir, `thumb-badge-${reelId}.txt`);
  await fsp.writeFile(labelFile, config.thumbnail.label, 'utf8');
  await fsp.writeFile(badgeFile, `#${sequence}`, 'utf8');

  const fontPath = escapeFilterPath(font);
  const accent = config.thumbnail.accent;

  // Badge geometry, kept in variables so the number can be centred inside the box.
  const badgeW = 240;
  const badgeH = 130;
  const badgeX = WIDTH - badgeW - 44;
  const badgeY = 44;

  const bandH = 190;
  const bandY = HEIGHT - bandH;

  const chain = [
    // Cover-crop rather than letterbox: a thumbnail with black bars looks broken.
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'eq=saturation=1.25:contrast=1.08:brightness=0.01',
    'vignette=PI/5',
    // Darkened band so the label stays readable over any footage.
    `drawbox=x=0:y=${bandY}:w=${WIDTH}:h=${bandH}:color=black@0.55:t=fill`,
    `drawbox=x=0:y=${bandY - 8}:w=${WIDTH}:h=8:color=${accent}:t=fill`,
    `drawbox=x=${badgeX}:y=${badgeY}:w=${badgeW}:h=${badgeH}:color=${accent}@0.95:t=fill`,
    drawText({
      fontPath,
      textFile: badgeFile,
      size: 92,
      x: `${badgeX}+(${badgeW}-text_w)/2`,
      y: `${badgeY}+(${badgeH}-text_h)/2`,
      borderWidth: 0,
    }),
    drawText({
      fontPath,
      textFile: labelFile,
      size: 96,
      x: '56',
      y: `${bandY}+(${bandH}-text_h)/2`,
      borderWidth: 6,
    }),
  ].join(',');

  await ffmpeg([
    '-y',
    ...threadArgs(),
    '-ss',
    timestamp.toFixed(2),
    '-i',
    video,
    '-frames:v',
    '1',
    '-vf',
    chain,
    // YouTube rejects thumbnails over 2MB; q:v 3 at 720p lands far below that.
    '-q:v',
    '3',
    out,
  ]);

  await Promise.all([
    fsp.rm(labelFile, { force: true }).catch(() => undefined),
    fsp.rm(badgeFile, { force: true }).catch(() => undefined),
  ]);

  logger.debug({ reelId, timestamp, sequence }, 'thumbnail generated');
  return out;
}

interface TextSpec {
  fontPath: string;
  textFile: string;
  size: number;
  x: string;
  y: string;
  borderWidth: number;
}

function drawText(spec: TextSpec): string {
  const parts = [
    'drawtext=',
    `fontfile='${spec.fontPath}'`,
    `:textfile='${escapeFilterPath(spec.textFile)}'`,
    ':fontcolor=white',
    `:fontsize=${spec.size}`,
    `:x=${spec.x}`,
    `:y=${spec.y}`,
    ':shadowcolor=black@0.6:shadowx=3:shadowy=3',
  ];
  if (spec.borderWidth > 0) parts.push(`:borderw=${spec.borderWidth}:bordercolor=black@0.85`);
  return parts.join('');
}

/**
 * Samples frames across the reel and keeps the most thumbnail-worthy one. A raw frame
 * grab at a fixed offset regularly lands on a loading screen, a fade, or a dark corner;
 * scoring for colour, contrast and mid-range brightness avoids that.
 */
async function pickBestFrame(video: string, duration: number): Promise<number> {
  const start = Math.min(1, duration * 0.05);
  const end = Math.max(start, duration * 0.95);
  const step = (end - start) / Math.max(1, CANDIDATES - 1);

  let bestTime = duration / 2;
  let bestScore = -Infinity;

  for (let i = 0; i < CANDIDATES; i++) {
    const t = start + step * i;
    const score = await scoreFrame(video, t);
    if (score !== null && score > bestScore) {
      bestScore = score;
      bestTime = t;
    }
  }

  return bestTime;
}

async function scoreFrame(video: string, seconds: number): Promise<number | null> {
  try {
    const { stdout } = await ffmpeg(
      [
        '-ss',
        seconds.toFixed(3),
        '-i',
        video,
        '-frames:v',
        '1',
        '-vf',
        `scale=${SCORE_W}:${SCORE_H}:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        '-',
      ],
      { binaryStdout: true, timeoutMs: 20_000 },
    );

    const expected = SCORE_W * SCORE_H * 3;
    if (stdout.length < expected) return null;
    return scorePixels(stdout.subarray(0, expected));
  } catch {
    return null;
  }
}

function scorePixels(rgb: Buffer): number {
  const pixels = rgb.length / 3;
  const luma: number[] = [];
  let colourfulness = 0;

  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    luma.push(0.299 * r + 0.587 * g + 0.114 * b);
    // Spread between channels: grey frames score zero, saturated ones score high.
    colourfulness += Math.max(r, g, b) - Math.min(r, g, b);
  }

  colourfulness /= pixels;

  const mean = luma.reduce((a, b) => a + b, 0) / pixels;
  const variance = luma.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pixels;
  const contrast = Math.sqrt(variance);

  // Penalise frames that are nearly black or blown out; 140 is a comfortable mid-tone.
  const exposure = Math.max(0, 100 - Math.abs(mean - 140) * 0.8);

  return colourfulness * 1.5 + contrast * 1.0 + exposure * 0.6;
}
