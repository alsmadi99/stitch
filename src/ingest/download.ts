import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { logger } from '../logger.js';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

let ytdlpAvailable: boolean | undefined;

export async function hasYtDlp(): Promise<boolean> {
  if (ytdlpAvailable !== undefined) return ytdlpAvailable;
  ytdlpAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn(YTDLP, ['--version'], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!ytdlpAvailable) logger.warn('yt-dlp not on PATH — link clips will be skipped');
  return ytdlpAvailable;
}

export class DownloadError extends Error {}

export interface YtDlpReport {
  available: boolean;
  version: string | null;
  /** Whether the bundled PO-token plugin was actually loaded from the image. */
  potPluginLoaded: boolean;
  /** Whether the provider named in `extractorArgs` answers. Null when none is set. */
  potProviderReachable: boolean | null;
}

/** The `base_url=` value out of the configured extractor args, if there is one. */
function potBaseUrl(): string | null {
  const marker = 'base_url=';
  const at = config.ingest.ytdlpExtractorArgs.indexOf(marker);
  if (at === -1) return null;
  const rest = config.ingest.ytdlpExtractorArgs.slice(at + marker.length);
  return rest.split(' ')[0]?.split(',')[0] || null;
}

/**
 * What yt-dlp can actually do in this container, answered without a network call.
 *
 * Every YouTube failure so far has had three candidate causes — stale binary, missing
 * plugin, unreachable provider — and no way to tell them apart from the outside. Asking
 * yt-dlp to load a deliberately invalid video id makes it print its plugin state and
 * stop, which distinguishes all three in about a second.
 */
export async function ytdlpReport(): Promise<YtDlpReport> {
  if (!(await hasYtDlp())) {
    return { available: false, version: null, potPluginLoaded: false, potProviderReachable: null };
  }

  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      const child = spawn(YTDLP, args, { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out));
    });

  const version = (await run(['--version'])).trim() || null;

  // An 11-character id that cannot exist: the extractor loads, prints what it has, and
  // fails before fetching anything.
  const probe = await run([
    '-v',
    '--simulate',
    '--no-warnings',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  ]);
  const potPluginLoaded = probe.includes('bgutil:http');

  let potProviderReachable: boolean | null = null;
  const base = potBaseUrl();
  if (base) {
    potProviderReachable = await fetch(base, { signal: AbortSignal.timeout(3000) })
      // Any answer at all proves it is listening; the status does not matter.
      .then(() => true)
      .catch(() => false);
  }

  return { available: true, version, potPluginLoaded, potProviderReachable };
}

/** Streams a direct file URL to disk, aborting if it grows past the configured cap. */
export async function downloadDirect(url: string, destBase: string): Promise<string> {
  const max = config.ingest.maxDownloadBytes;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new DownloadError(`HTTP ${res.status} fetching ${url}`);
  if (!res.body) throw new DownloadError('empty response body');

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new DownloadError(`file is ${declared} bytes, over the ${max} cap`);

  const ext = path.extname(new URL(url).pathname) || '.mp4';
  const dest = `${destBase}${ext}`;

  try {
    let written = 0;
    await pipeline(
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      async function* capped(source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > max) throw new DownloadError(`download exceeded ${max} bytes`);
          yield chunk;
        }
      },
      fs.createWriteStream(dest),
    );
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err;
  }

  return dest;
}

/** Downloads a hosted clip (Medal, Streamable, Twitch, YouTube, …) via yt-dlp. */
/**
 * Turns yt-dlp stderr into one line worth reading in a log.
 *
 * The bot check prints two wiki URLs and a paragraph, repeated on every rejected clip.
 * What matters is which of the three fixes to reach for.
 */
function explainYtDlpFailure(code: number | null, stderr: string): string {
  const last = stderr.trim().split('\n').slice(-1)[0] ?? '';

  if (/confirm you.{0,3}re not a bot|Sign in to confirm/i.test(stderr)) {
    return (
      'YouTube refused this as a suspected bot — about the server IP, not the URL. Update ' +
      'yt-dlp (rebuild the image), then try ingest.extractorArgs in src/constants.ts, then ' +
      'drop a cookies.txt into the data directory.'
    );
  }
  if (/Video unavailable|Private video|members-only/i.test(stderr)) {
    return `the video is not publicly available (${last})`;
  }
  return `yt-dlp exited ${code}: ${last}`;
}

export async function downloadViaYtDlp(
  url: string,
  destBase: string,
  maxBytes = config.ingest.maxDownloadBytes,
): Promise<string> {
  if (!(await hasYtDlp())) throw new DownloadError('yt-dlp is not installed');

  const maxMb = Math.floor(maxBytes / 1_048_576);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--max-filesize',
    `${maxMb}m`,
    '--merge-output-format',
    'mp4',
    '-f',
    'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '-o',
    `${destBase}.%(ext)s`,
  ];

  // YouTube answers datacenter IPs with "Sign in to confirm you're not a bot". A cookie
  // jar is what clears it; which player client also works changes often enough that it
  // has to be configurable rather than pinned here.
  // Absent is the normal case, so it is not worth a line in the log — the path is always
  // set now that it is derived rather than configured.
  const cookies = config.ingest.ytdlpCookiesFile;
  if (fs.existsSync(cookies)) args.push('--cookies', cookies);
  if (config.ingest.ytdlpExtractorArgs) {
    args.push('--extractor-args', config.ingest.ytdlpExtractorArgs);
  }

  args.push(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(YTDLP, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new DownloadError(explainYtDlpFailure(code, err))),
    );
  });

  const dir = path.dirname(destBase);
  const stem = path.basename(destBase);
  const produced = (await fsp.readdir(dir)).find((f) => f.startsWith(`${stem}.`));
  if (!produced) throw new DownloadError('yt-dlp produced no file (likely over the size cap)');

  // `--max-filesize` is checked against the size a site declares up front, which is
  // missing or wrong often enough to matter — and when two streams are merged it applies
  // to each, not the result. Measuring the finished file is the check that always holds.
  const file = path.join(dir, produced);
  const { size } = await fsp.stat(file);
  if (size > maxBytes) {
    await fsp.rm(file, { force: true });
    throw new DownloadError(
      `download is ${Math.round(size / 1_048_576)}MB, over the ${Math.round(maxBytes / 1_048_576)}MB cap for links`,
    );
  }
  return file;
}
