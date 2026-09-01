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
    url,
  ];

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
        : reject(new DownloadError(`yt-dlp exited ${code}: ${err.trim().split('\n').slice(-1)[0]}`)),
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
