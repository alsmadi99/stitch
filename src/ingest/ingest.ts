import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as clips from '../db/clips.js';
import type { Candidate, ClipRow } from '../types.js';
import { downloadDirect, downloadViaYtDlp } from './download.js';
import { probe } from './probe.js';
import { fingerprintDistance, sha256File, videoFingerprint } from './fingerprint.js';

export const ingestEvents = new EventEmitter();

export class DiskFullError extends Error {}

/**
 * Refuses to start a download when the data volume is nearly full. Without this a long
 * backfill quietly fills the disk and takes the rest of the host down with it.
 */
export async function assertDiskSpace(): Promise<void> {
  const stats = await fsp.statfs(config.paths.dataDir).catch(() => null);
  if (!stats) return;

  const freeMb = (stats.bavail * stats.bsize) / 1_048_576;
  if (freeMb < config.ingest.minFreeDiskMb) {
    throw new DiskFullError(
      `only ${Math.round(freeMb)}MB free on the data volume, need ${config.ingest.minFreeDiskMb}MB`,
    );
  }
}

export type IngestOutcome =
  | { kind: 'accepted'; clipId: number }
  | { kind: 'duplicate'; clipId: number; ofClipId: number; reason: 'hash' | 'perceptual' }
  | { kind: 'rejected'; clipId: number | null; reason: string }
  | { kind: 'known' };

/**
 * Download a candidate, fingerprint it, and either queue it or mark it a duplicate.
 * Safe to call concurrently for different messages.
 */
export async function ingestCandidate(candidate: Candidate): Promise<IngestOutcome> {
  const clipId = clips.insertCandidate(candidate);
  if (clipId === null) return { kind: 'known' };

  const log = logger.child({ clipId, url: candidate.sourceUrl.slice(0, 120) });
  const destBase = path.join(config.paths.rawDir, `clip-${clipId}`);
  let file: string | null = null;

  try {
    await assertDiskSpace();

    file =
      candidate.sourceType === 'attachment'
        ? await downloadDirect(candidate.sourceUrl, destBase)
        : await downloadViaYtDlp(candidate.sourceUrl, destBase, config.ingest.maxLinkBytes);

    const meta = await probe(file);

    if (meta.duration < config.video.minClipSeconds) {
      throw new Error(`clip is ${meta.duration.toFixed(1)}s, shorter than the ${config.video.minClipSeconds}s minimum`);
    }

    const contentHash = await sha256File(file);
    const byHash = clips.findByContentHash(contentHash);
    if (byHash && byHash.id !== clipId) {
      await discard(file);
      clips.updateClip(clipId, { content_hash: contentHash, duration: meta.duration });
      clips.setStatus(clipId, 'duplicate', `byte-identical to clip ${byHash.id}`);
      log.info({ ofClipId: byHash.id }, 'duplicate (exact)');
      return { kind: 'duplicate', clipId, ofClipId: byHash.id, reason: 'hash' };
    }

    const phash = await videoFingerprint(file, meta.duration);
    if (phash) {
      const near = findPerceptualMatch(phash, meta.duration, clipId);
      if (near) {
        await discard(file);
        clips.updateClip(clipId, { content_hash: contentHash, phash, duration: meta.duration });
        clips.setStatus(clipId, 'duplicate', `visually identical to clip ${near.id}`);
        log.info({ ofClipId: near.id }, 'duplicate (perceptual)');
        return { kind: 'duplicate', clipId, ofClipId: near.id, reason: 'perceptual' };
      }
    }

    clips.updateClip(clipId, {
      file_path: file,
      content_hash: contentHash,
      phash,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      has_audio: meta.hasAudio ? 1 : 0,
    });

    log.info({ duration: meta.duration, size: `${meta.width}x${meta.height}` }, 'clip queued');
    ingestEvents.emit('accepted', clipId);
    return { kind: 'accepted', clipId };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (file) await discard(file);

    if (err instanceof DiskFullError) {
      // Not the clip's fault — leave it pending so it is retried once space frees up.
      log.error({ err: reason }, 'out of disk space, ingest paused');
      throw err;
    }

    clips.setStatus(clipId, 'rejected', reason);
    log.warn({ err: reason }, 'clip rejected');
    return { kind: 'rejected', clipId, reason };
  }
}

function findPerceptualMatch(phash: string, duration: number, selfId: number): ClipRow | null {
  const neighbours = clips.findByDurationWindow(duration);
  for (const other of neighbours) {
    if (other.id === selfId || !other.phash) continue;
    if (fingerprintDistance(phash, other.phash) <= config.ingest.phashThreshold) return other;
  }
  return null;
}

async function discard(file: string): Promise<void> {
  await fsp.rm(file, { force: true }).catch(() => undefined);
}
