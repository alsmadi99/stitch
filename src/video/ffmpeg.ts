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
 * Thread caps for the *input* side: decoding and filtering.
 *
 * `-threads` is positional. Placed before `-i` it configures the decoder only, which is
 * why the encoder needs its own copy in `encoderArgs` — see the note there.
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
  const { threads } = config.video;

  return [
    // Repeated on the output side deliberately. `-threads` is positional: the copy
    // before `-i` binds the decoder, and without one here x264 sizes its own pool from
    // the host's core count. A cgroup CPU quota does not change what the process reads
    // from the machine, so a 2-CPU container on a 12-core host still spun up 12 encoder
    // threads, each holding frame buffers at full resolution.
    ...(threads > 0 ? ['-threads', String(threads)] : []),
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    String(Math.max(0, Math.round(crf))),
    '-pix_fmt',
    'yuv420p',
    // Deliberately no `-r`. Normalize already pins every clip to a constant frame rate
    // with the `fps` filter, so re-asserting an output rate here is redundant — and it
    // is the one remaining step that can invent frames: given an input whose timestamps
    // jump, the rate converter duplicates frames to fill the gap, without bound.
    '-fps_mode',
    'passthrough',
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
    /** The command that failed. Without it, a kill leaves nothing to diagnose. */
    readonly args: string[] = [],
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

    // memory.stat is a *current* reading, so sampling it after the process dies reports
    // the memory it already released — useless for explaining why it died. Poll while it
    // runs and keep the high-water mark instead.
    let peakAnonMb = 0;
    const sampler = setInterval(() => {
      const anon = memorySnapshot().anonMb;
      if (anon !== null && anon > peakAnonMb) peakAnonMb = anon;
    }, 1000);
    sampler.unref();

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
      clearInterval(sampler);

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
        const mem = memorySnapshot();
        const facts = [
          mem.limitMb !== null ? `limit ${mem.limitMb}MB` : 'no container memory limit',
          mem.peakMb !== null ? `peak ${mem.peakMb}MB` : null,
          peakAnonMb > 0 ? `peak anon ${peakAnonMb}MB while running` : null,
          mem.cacheMb !== null ? `cache now ${mem.cacheMb}MB` : null,
          `config ${config.video.width}x${config.video.height} batch ${config.video.stitchBatch}`,
          mem.oomKills !== null ? `${mem.oomKills} OOM kill(s) on this container` : null,
        ]
          .filter(Boolean)
          .join(', ');

        const confirmedOom = (mem.oomKills ?? 0) > 0;
        message =
          `${bin} was killed by ${signal} after ${elapsed}s with no error output ` +
          `(${facts}). ` +
          (confirmedOom
            ? 'The kernel OOM counter confirms it ran out of memory — lower STITCH_BATCH, ' +
              'set OUTPUT_HEIGHT=720, or raise the container memory limit.'
            : 'No OOM was recorded against this container, so look for an external kill: ' +
              'a redeploy, a manual stop, or the host itself being out of memory.');
      } else {
        message = `${bin} exited ${code}: ${lastLine}`;
      }

      // The command is the one thing that makes a kill diagnosable at all, so it goes
      // in the log even though it is long.
      logger.error({ bin, args, signal, code }, 'ffmpeg command failed');
      reject(new FfmpegError(message, code, err, signal, timedOut, args));
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

function readCgroup(...files: string[]): string | null {
  for (const file of files) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      // Not in a container, or this cgroup version does not expose the file.
    }
  }
  return null;
}

export interface MemorySnapshot {
  limitMb: number | null;
  peakMb: number | null;
  /** Kernel OOM kills counted against this cgroup since boot. */
  oomKills: number | null;
  /** Anonymous memory — what processes actually allocated. */
  anonMb: number | null;
  /** Page cache. Counts against the cgroup limit but is reclaimable. */
  cacheMb: number | null;
}

/**
 * What the kernel says about this container's memory, so an OOM can be reported as a
 * fact rather than as a guess. `memory.events` counts OOM kills against the cgroup, and
 * that counter rising is the difference between "probably out of memory" and "the
 * kernel killed it".
 */
export function memorySnapshot(): MemorySnapshot {
  const events = readCgroup('/sys/fs/cgroup/memory.events');
  const oomFromV2 = events?.match(/^oom_kill (\d+)$/m)?.[1];
  const oomFromV1 = readCgroup('/sys/fs/cgroup/memory/memory.failcnt');

  const toMb = (raw: string | null): number | null => {
    if (raw === null || raw === 'max') return null;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 2 ** 52) return null;
    return Math.round(bytes / 1_048_576);
  };

  // Splitting anonymous memory from page cache matters: a peak equal to the limit says
  // nothing on its own, because reading and writing video fills the cache and that
  // counts against the cgroup too. Only the anonymous figure is what ffmpeg allocated.
  const stat = readCgroup('/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory/memory.stat');
  const fromStat = (key: string): number | null => {
    const raw = stat?.match(new RegExp(`^${key} (\\d+)$`, 'm'))?.[1];
    return raw === undefined ? null : Math.round(Number(raw) / 1_048_576);
  };

  return {
    limitMb: containerMemoryLimitMb(),
    peakMb: toMb(readCgroup('/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes')),
    oomKills: oomFromV2 !== undefined ? Number(oomFromV2) : oomFromV1 !== null ? Number(oomFromV1) : null,
    anonMb: fromStat('anon') ?? fromStat('rss'),
    cacheMb: fromStat('file') ?? fromStat('cache'),
  };
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
 * Those measurements used synthetic test patterns, and the margin below is what stands
 * between the model and real footage. It started at 1.25 and was raised after a real
 * deployment: the model predicted 1531MB for 1080p at batch 3, and the kernel recorded
 * a peak of 3072MB before killing ffmpeg. High-motion gameplay retains far more
 * reference data than a test pattern, so an optimistic estimate here is worse than
 * useless — it reads "comfortable" right up until the OOM.
 */
const REAL_FOOTAGE_MARGIN = 2;

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
