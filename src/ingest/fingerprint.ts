import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ffmpeg } from '../video/ffmpeg.js';

/** Sample points as a fraction of the clip, avoiding fade-in/out at the very edges. */
const SAMPLE_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * dHash of one frame: downscale to 9x8 grayscale, then emit one bit per horizontally
 * adjacent pixel pair (is the left pixel brighter?). 64 bits, 16 hex chars.
 * Survives re-encoding and rescaling, which is what a re-uploaded clip looks like.
 */
function dHash(gray9x8: Buffer): string {
  let bits = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = gray9x8[row * 9 + col] ?? 0;
      const right = gray9x8[row * 9 + col + 1] ?? 0;
      bits += left > right ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

async function frameHash(file: string, seconds: number): Promise<string | null> {
  try {
    const { stdout } = await ffmpeg(
      [
        '-ss',
        seconds.toFixed(3),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        'scale=9:8:flags=area,format=gray',
        '-f',
        'rawvideo',
        '-',
      ],
      { binaryStdout: true, timeoutMs: 30_000 },
    );
    return stdout.length >= 72 ? dHash(stdout.subarray(0, 72)) : null;
  } catch {
    return null;
  }
}

/** Perceptual fingerprint: five frame hashes joined by `-`. */
export async function videoFingerprint(file: string, duration: number): Promise<string | null> {
  const hashes = await Promise.all(
    SAMPLE_POINTS.map((p) => frameHash(file, Math.max(0, duration * p))),
  );
  const usable = hashes.filter((h): h is string => h !== null);
  return usable.length >= 3 ? hashes.map((h) => h ?? '0000000000000000').join('-') : null;
}

function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Mean per-frame Hamming distance between two fingerprints (0 = identical, 64 = opposite). */
export function fingerprintDistance(a: string, b: string): number {
  const fa = a.split('-');
  const fb = b.split('-');
  const n = Math.min(fa.length, fb.length);
  if (n === 0) return Number.POSITIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < n; i++) total += hammingHex(fa[i]!, fb[i]!);
  return total / n;
}
