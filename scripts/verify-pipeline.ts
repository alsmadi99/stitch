/**
 * End-to-end check that a reel contains every clip, once, in the right place.
 *
 * Builds a reel from generated clips that deliberately behave like real capture output —
 * variable frame rate, timestamps that do not start at zero, audio longer than video,
 * mixed resolutions and frame rates — then samples the finished video and asserts that
 * each clip occupies its own slot for its whole span.
 *
 * Each clip is a distinct grey level rather than a colour: two colours crossfading can
 * pass exactly through a third colour, which reads as a clip appearing twice when it is
 * only the blend. Grey levels have no such collisions. The level for each clip is read
 * from the output rather than assumed, because encoding shifts them.
 *
 *   npm run verify
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { ffmpeg, FFMPEG } from '../src/video/ffmpeg.js';
import { probe } from '../src/ingest/probe.js';
import { compileReel } from '../src/video/compile.js';
import type { ClipRow } from '../src/types.js';

type Kind = 'cfr' | 'vfr' | 'offset-pts' | 'audio-longer';

const SPEC: { level: number; seconds: number; kind: Kind; size: string; fps: number }[] = [
  { level: 30, seconds: 7.37, kind: 'cfr', size: '1920x1080', fps: 30 },
  { level: 60, seconds: 4.11, kind: 'vfr', size: '1280x720', fps: 60 },
  { level: 90, seconds: 9.83, kind: 'vfr', size: '2560x1440', fps: 24 },
  { level: 120, seconds: 3.29, kind: 'offset-pts', size: '854x480', fps: 25 },
  { level: 150, seconds: 11.55, kind: 'audio-longer', size: '1920x1080', fps: 30 },
  { level: 180, seconds: 5.97, kind: 'vfr', size: '1280x720', fps: 50 },
  { level: 205, seconds: 8.13, kind: 'cfr', size: '1920x1080', fps: 30 },
  { level: 230, seconds: 6.71, kind: 'offset-pts', size: '1920x1080', fps: 60 },
];

const SAMPLE_FPS = 20;
/** Grey levels are ~30 apart, so this tolerance identifies a clip without ambiguity. */
const LEVEL_TOLERANCE = 6;
const MIN_STABILITY = 0.9;

async function buildSource(index: number): Promise<string> {
  const spec = SPEC[index]!;
  const file = path.join(config.paths.rawDir, `verify-${index}.mp4`);
  if (fs.existsSync(file)) return file;

  const hex = [spec.level, spec.level, spec.level]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  // A moving box keeps frames different, so variable-rate frame selection really varies.
  const source =
    `color=c=0x${hex}:size=${spec.size}:rate=${spec.fps},` +
    `drawbox=x='mod(t*200,1200)':y=200:w=40:h=40:color=black:t=fill`;
  const audioSeconds = spec.kind === 'audio-longer' ? spec.seconds + 0.9 : spec.seconds;

  const args = [
    '-y',
    '-f', 'lavfi', '-t', String(spec.seconds), '-i', source,
    '-f', 'lavfi', '-t', String(audioSeconds), '-i', `sine=frequency=${300 + index * 70}`,
  ];
  if (spec.kind === 'vfr') args.push('-vf', "select='gt(random(0),0.35)'", '-fps_mode', 'vfr');
  // One offset mechanism, not two. Stacking setpts on top of -output_ts_offset shifts
  // the picture by 14s while the container still reports a 7s start, which no amount of
  // arithmetic on the metadata can untangle — and no real recorder produces it.
  if (spec.kind === 'offset-pts') args.push('-output_ts_offset', '7');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file);

  await ffmpeg(args);
  return file;
}

/** One grey value per sampled frame of the finished reel. */
function sampleLevels(video: string): Promise<number[]> {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-i', video,
      '-vf', `fps=${SAMPLE_FPS},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.resume();
    child.on('close', () => resolve([...Buffer.concat(chunks)]));
  });
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const rows: ClipRow[] = [];
const durations: number[] = [];

for (let i = 0; i < SPEC.length; i++) {
  const file = await buildSource(i);
  const meta = await probe(file);
  durations.push(Math.min(meta.videoDuration, config.video.maxClipSeconds));
  rows.push({
    id: i + 1, message_id: `verify-${i}`, channel_id: 'c', guild_id: 'g',
    author_id: 'u', author_name: 'verify', source_type: 'attachment', source_url: 'x',
    file_path: file, content_hash: null, phash: null, duration: meta.duration,
    width: meta.width, height: meta.height, has_audio: 1, status: 'pending',
    reel_id: null, note: null,
    message_at: new Date().toISOString(), created_at: new Date().toISOString(),
  });
}

const transition = config.video.transitionDuration;
const frameAligned = durations.map((d) => Math.floor(d * config.video.fps) / config.video.fps);
const expected = frameAligned.reduce((a, b) => a + b, 0) - (rows.length - 1) * transition;

const startedAt = Date.now();
const reel = await compileReel(9001, rows, 1);
const out = await probe(reel.videoPath);
const levels = await sampleLevels(reel.videoPath);

console.log(
  `\nreel ${out.width}x${out.height}  ${out.videoDuration.toFixed(2)}s` +
    `  expected ${expected.toFixed(2)}s  drift ${((out.videoDuration - expected) * 1000).toFixed(0)}ms` +
    `  built in ${((Date.now() - startedAt) / 1000).toFixed(0)}s\n`,
);
console.log('clip  kind            window            level   on screen');

const seen: { index: number; level: number }[] = [];
let problems = 0;
let position = 0;

for (let i = 0; i < SPEC.length; i++) {
  const from = i === 0 ? 0 : position + transition;
  const to = i === SPEC.length - 1 ? position + frameAligned[i]! : position + frameAligned[i]! - transition;

  // Sample the middle 60% so crossfades at either edge cannot skew the reading.
  const window = levels.slice(
    Math.round((from + (to - from) * 0.2) * SAMPLE_FPS),
    Math.round((from + (to - from) * 0.8) * SAMPLE_FPS),
  );
  const level = median(window);
  const stability = window.filter((v) => Math.abs(v - level) <= LEVEL_TOLERANCE).length / (window.length || 1);
  const duplicate = seen.find((s) => Math.abs(s.level - level) <= LEVEL_TOLERANCE);

  const notes = [
    stability < MIN_STABILITY ? 'NOT STABLE — clip not shown for its whole span' : '',
    duplicate ? `SAME AS CLIP ${duplicate.index} — a clip appears twice` : '',
  ].filter(Boolean);
  if (notes.length > 0) problems++;

  console.log(
    `  ${i}   ${SPEC[i]!.kind.padEnd(14)} ${`${from.toFixed(1)}-${to.toFixed(1)}s`.padEnd(16)} ` +
      `${String(level).padStart(4)}    ${(stability * 100).toFixed(0)}%` +
      (notes.length ? `  <-- ${notes.join('; ')}` : ''),
  );

  seen.push({ index: i, level });
  position += frameAligned[i]! - transition;
}

fs.rmSync(reel.videoPath, { force: true });
fs.rmSync(reel.thumbnailPath, { force: true });

console.log(
  problems === 0
    ? '\nPASS — every clip occupies its own slot, fully and exactly once'
    : `\nFAIL — ${problems} problem(s)`,
);

setTimeout(() => process.exit(problems === 0 ? 0 : 1), 50);
