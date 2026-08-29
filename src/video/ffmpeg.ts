import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

/**
 * ffmpeg-static and ffprobe-static are convenient for local development but carry
 * ~410MB of binaries for every platform, and the static Linux ffmpeg has no drawtext
 * filter. The container installs the distro build and omits both packages, so they are
 * resolved optionally rather than imported.
 */
function bundledBinary(pkg: string, pick: (mod: unknown) => unknown): string | null {
  try {
    const value = pick(require(pkg));
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export const FFMPEG =
  process.env.FFMPEG_PATH || bundledBinary('ffmpeg-static', (m) => m) || 'ffmpeg';

export const FFPROBE =
  process.env.FFPROBE_PATH ||
  bundledBinary('ffprobe-static', (m) => (m as { path?: string }).path) ||
  'ffprobe';

/**
 * Caps ffmpeg's own threading. Left at 0 (auto) it spawns one worker per core and will
 * happily saturate a small VPS while the bot still needs to answer the gateway.
 */
export function threadArgs(): string[] {
  const { threads } = config.video;
  return threads > 0 ? ['-threads', String(threads), '-filter_threads', String(threads)] : [];
}

/**
 * The output codec settings every stage shares, so batches stay compatible.
 *
 * Intermediate stitch levels pass a lower CRF: footage is re-encoded once per tree
 * level plus once during normalize, and compounding the final quality setting three or
 * four times is visible. Only the last pass uses the configured CRF.
 */
export function encoderArgs(crf = config.video.crf): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    config.video.preset,
    '-crf',
    String(Math.max(0, Math.round(crf))),
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
  ];
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

interface RunOptions {
  /** Collect stdout as a Buffer instead of discarding it (used for raw frame output). */
  binaryStdout?: boolean;
  timeoutMs?: number;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    logger.debug({ bin, args }, 'spawn');
    const child = spawn(bin, args, { windowsHide: true });

    const out: Buffer[] = [];
    let err = '';
    let timer: NodeJS.Timeout | undefined;

    child.stdout.on('data', (d: Buffer) => {
      if (opts.binaryStdout) out.push(d);
    });
    // ffmpeg writes progress to stderr; keep only the tail so a failure message stays readable.
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 64_000) err = err.slice(-32_000);
    });

    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr: err });
      } else {
        const lastLine = err.trim().split('\n').slice(-1)[0] ?? '';
        reject(new FfmpegError(`${bin} exited ${code}: ${lastLine}`, code, err));
      }
    });
  });
}

export function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], opts);
}

export function ffprobe(args: string[]): Promise<RunResult> {
  return run(FFPROBE, ['-hide_banner', '-loglevel', 'error', ...args], { binaryStdout: true });
}

/**
 * ffmpeg filtergraphs use `:` and `\` as syntax, so a Windows path such as
 * `C:\Windows\Fonts\arial.ttf` has to be handed over as `C\:/Windows/Fonts/arial.ttf`.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

let filterCache: Set<string> | null = null;

/**
 * Whether this ffmpeg build actually has a filter. Builds differ in what they were
 * compiled with — notably the static Linux ffmpeg-static binary has no libfreetype and
 * therefore no `drawtext` — and a missing filter otherwise fails the whole encode.
 */
export async function hasFilter(name: string): Promise<boolean> {
  if (!filterCache) {
    try {
      const { stdout } = await ffmpeg(['-filters'], { binaryStdout: true });
      filterCache = new Set(
        stdout
          .toString('utf8')
          .split('\n')
          .map((line) => line.trim().split(/\s+/)[1] ?? '')
          .filter(Boolean),
      );
    } catch {
      filterCache = new Set();
    }
  }
  return filterCache.has(name);
}

/** True when text can be burned into video: the filter exists and a font is installed. */
export async function canDrawText(fontFile?: string): Promise<boolean> {
  if (!(await hasFilter('drawtext'))) {
    logger.warn(
      { ffmpeg: FFMPEG },
      'this ffmpeg build has no drawtext filter — text overlays will be skipped',
    );
    return false;
  }
  return resolveFont(fontFile) !== null;
}

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/segoeuib.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
];

let cachedFont: string | null | undefined;

export function resolveFont(explicit?: string): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  if (cachedFont !== undefined) return cachedFont;
  cachedFont = FONT_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
  if (!cachedFont) logger.warn('no TTF font found — title cards will be skipped');
  return cachedFont;
}
