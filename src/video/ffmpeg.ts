import { spawn } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { logger } from '../logger.js';

// ffmpeg-static's default export is the binary path, but its bundled .d.ts declares a
// module namespace under NodeNext resolution, hence the cast.
const bundledFfmpeg = ffmpegStatic as unknown as string | null;

export const FFMPEG = process.env.FFMPEG_PATH || bundledFfmpeg || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe';

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

/** drawtext refuses most punctuation unless escaped. */
export function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
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
