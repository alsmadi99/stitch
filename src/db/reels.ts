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

/** Sequence number used in the video title — counts reels that reached YouTube. */
export function publishedReelCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM reels WHERE status IN ('uploaded', 'published')")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function latestReel(): ReelRow | undefined {
  return db.prepare('SELECT * FROM reels ORDER BY id DESC LIMIT 1').get() as ReelRow | undefined;
}
