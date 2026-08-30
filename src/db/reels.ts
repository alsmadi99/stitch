import { db } from './index.js';
import type { ReelRow, ReelStatus } from '../types.js';

export function createReel(clipCount: number): number {
  const res = db.prepare("INSERT INTO reels (status, clip_count) VALUES ('building', ?)").run(clipCount);
  return Number(res.lastInsertRowid);
}

export function getReel(id: number): ReelRow | undefined {
  return db.prepare('SELECT * FROM reels WHERE id = ?').get(id) as ReelRow | undefined;
}

export function updateReel(id: number, patch: Partial<ReelRow>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE reels SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function setReelStatus(id: number, status: ReelStatus, error?: string): void {
  db.prepare('UPDATE reels SET status = ?, error = ? WHERE id = ?').run(status, error ?? null, id);
}

/**
 * Episode number base. Counts every reel that got as far as a finished video, so the
 * numbering keeps advancing in local-only mode and a failed run does not burn a number.
 */
export function completedReelCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM reels WHERE status IN ('ready', 'uploading', 'uploaded', 'published')")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Built reels whose upload has not succeeded and whose backoff has elapsed. */
export function dueForUpload(now: string): ReelRow[] {
  return db
    .prepare(
      `SELECT * FROM reels
       WHERE status = 'pending_upload'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id`,
    )
    .all(now) as ReelRow[];
}

export function pendingUploadCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM reels WHERE status = 'pending_upload'")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Reels left mid-flight by a crash or redeploy — their clips need releasing. */
export function unfinishedReels(): ReelRow[] {
  return db
    .prepare("SELECT * FROM reels WHERE status IN ('building', 'uploading') ORDER BY id")
    .all() as ReelRow[];
}

/** Uploaded reels that are not yet in the series playlist. */
export function missingFromPlaylist(): ReelRow[] {
  return db
    .prepare(
      `SELECT * FROM reels
       WHERE youtube_id IS NOT NULL AND playlist_item_id IS NULL
       ORDER BY id`,
    )
    .all() as ReelRow[];
}

/**
 * Reels whose title carries this episode number.
 *
 * The episode is what the video is called on YouTube; the row id is an internal counter
 * that a failed reel still consumes. Matched on a `#N` not followed by another digit, so
 * asking for #8 does not also return #80.
 */
export function findByEpisode(episode: number): ReelRow[] {
  const rows = db
    .prepare(`SELECT * FROM reels WHERE title LIKE ? ORDER BY id DESC`)
    .all(`%#${episode}%`) as ReelRow[];
  const exact = new RegExp(`#${episode}(?![0-9])`);
  return rows.filter((r) => exact.test(r.title ?? ''));
}

export function latestReel(): ReelRow | undefined {
  return db.prepare('SELECT * FROM reels ORDER BY id DESC LIMIT 1').get() as ReelRow | undefined;
}
