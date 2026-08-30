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
export function encoderArgs(crf = config.video.crf, preset = config.video.preset): string[] {
  return [
    '-c:v',
    'libx264',
    '-preset',
    preset,
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
    /** Set when the process was killed rather than exiting on its own. */
    readonly signal: NodeJS.Signals | null = null,
    readonly timedOut = false,
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
    const startedAt = Date.now();
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

    let timedOut = false;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
    }

    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout: Buffer.concat(out), stderr: err });
        return;
      }

      const lastLine = err.trim().split('\n').slice(-1)[0] ?? '';
      const elapsed = Math.round((Date.now() - startedAt) / 1000);

      // A null exit code means the process was killed rather than having failed, and a
      // killed ffmpeg never gets to write to stderr. Reporting only "exited null"
      // discards the one detail that identifies the killer, so name it explicitly.
      let message: string;
      if (timedOut) {
        const limit = Math.round((opts.timeoutMs ?? 0) / 1000);
        message = `${bin} was killed after exceeding its ${limit}s timeout (ran ${elapsed}s)`;
      } else if (signal) {
        message =
          `${bin} was killed by ${signal} after ${elapsed}s with no error output. ` +
          'That is almost always the kernel OOM killer reclaiming memory after the ' +
          'container hit its limit — lower STITCH_BATCH, drop OUTPUT_HEIGHT to 720, ' +
          'or raise the memory limit.';
      } else {
        message = `${bin} exited ${code}: ${lastLine}`;
      }

      reject(new FfmpegError(message, code, err, signal, timedOut));
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

/**
 * The container's memory ceiling, or null when unlimited / not in a cgroup.
 * cgroup v2 first, then v1.
 */
export function containerMemoryLimitMb(): number | null {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') return null;
      const bytes = Number(raw);
      // An unset v1 limit shows up as a number near 2^63, not as "max".
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 2 ** 52) return null;
      return Math.round(bytes / 1_048_576);
    } catch {
      // Not in a container, or the file is unreadable. Try the next one.
    }
  }
  return null;
}

/**
 * Rough peak RSS for one stitch call, used to warn before a run rather than discovering
 * the ceiling through an OOM kill.
 *
 * Fitted to measurements at 1080p — 1030MB at batch 3, 1200MB at 4, 1450MB at 5 — which
 * gives roughly 380MB fixed plus 215MB per input held open, scaled by pixel count.
 *
 * Those measurements used synthetic test patterns. Real gameplay is high-motion H.264
 * with B-frames and far larger reference buffers, so the estimate carries a margin;
 * without it the prediction reads comfortable right up until the kernel disagrees.
 */
const REAL_FOOTAGE_MARGIN = 1.25;

export function estimatedStitchPeakMb(): number {
  const pixelRatio = (config.video.width * config.video.height) / (1920 * 1080);
  const base = 380 + 215 * config.video.stitchBatch;
  return Math.round(base * pixelRatio * REAL_FOOTAGE_MARGIN);
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
