import { db } from './index.js';
import type { Candidate, ClipRow, ClipStatus } from '../types.js';

const insertStmt = db.prepare(`
  INSERT INTO clips (message_id, channel_id, guild_id, author_id, author_name,
                     source_type, source_url, status, message_at)
  VALUES (@messageId, @channelId, @guildId, @authorId, @authorName,
          @sourceType, @sourceUrl, 'pending', @messageAt)
  ON CONFLICT (message_id, source_url) DO NOTHING
`);

/** Returns the new row id, or null when this exact message+url was already recorded. */
export function insertCandidate(c: Candidate): number | null {
  const res = insertStmt.run({
    messageId: c.messageId,
    channelId: c.channelId,
    guildId: c.guildId,
    authorId: c.authorId,
    authorName: c.authorName,
    sourceType: c.sourceType,
    sourceUrl: c.sourceUrl,
    messageAt: c.messageAt.toISOString(),
  });
  return res.changes > 0 ? Number(res.lastInsertRowid) : null;
}

export function getClip(id: number): ClipRow | undefined {
  return db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as ClipRow | undefined;
}

export function updateClip(id: number, patch: Partial<ClipRow>): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE clips SET ${set} WHERE id = @id`).run({ ...patch, id });
}

export function setStatus(id: number, status: ClipStatus, note?: string): void {
  db.prepare('UPDATE clips SET status = ?, note = COALESCE(?, note) WHERE id = ?').run(
    status,
    note ?? null,
    id,
  );
}

export function countPending(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM clips WHERE status = 'pending' AND file_path IS NOT NULL")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Oldest-first, so a reel is chronological and no clip starves in the queue. */
export function takePending(limit: number): ClipRow[] {
  return db
    .prepare(
      `SELECT * FROM clips
       WHERE status = 'pending' AND file_path IS NOT NULL
       ORDER BY message_at ASC
       LIMIT ?`,
    )
    .all(limit) as ClipRow[];
}

/**
 * The clips that went into one reel, in the order the reel used.
 *
 * Ordered the same way `takePending` selects them, so a rebuild lays the clips out in
 * the sequence the original upload had rather than a new one.
 */
export function clipsForReel(reelId: number): ClipRow[] {
  return db
    .prepare(`SELECT * FROM clips WHERE reel_id = ? ORDER BY message_at ASC, id ASC`)
    .all(reelId) as ClipRow[];
}

/** Every clip extracted from one message — a post can carry several. */
export function findByMessageId(messageId: string): ClipRow[] {
  return db
    .prepare('SELECT * FROM clips WHERE message_id = ? ORDER BY id')
    .all(messageId) as ClipRow[];
}

export function findByContentHash(hash: string): ClipRow | undefined {
  return db
    .prepare("SELECT * FROM clips WHERE content_hash = ? AND status != 'duplicate' LIMIT 1")
    .get(hash) as ClipRow | undefined;
}

/**
 * Candidates for perceptual comparison: fingerprinted clips of a similar length.
 *
 * The window is only a cheap prefilter — the fingerprint threshold is what actually
 * decides a match — so it is generous. A fixed 1.5s was too tight: the same clip
 * re-posted from a different capture tool is often trimmed a second or two differently
 * at each end, which put it outside the window and let a duplicate into the reel.
 */
export function findByDurationWindow(duration: number, slack = Math.max(3, duration * 0.25)): ClipRow[] {
  return db
    .prepare(
      `SELECT * FROM clips
       WHERE phash IS NOT NULL AND status != 'duplicate'
         AND duration BETWEEN ? AND ?`,
    )
    .all(duration - slack, duration + slack) as ClipRow[];
}

export function markUsed(clipIds: number[], reelId: number): void {
  const stmt = db.prepare("UPDATE clips SET status = 'used', reel_id = ? WHERE id = ?");
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(reelId, id);
  });
  tx(clipIds);
}

/** Put a failed reel's clips back in the queue so nothing is lost. */
export function releaseClips(reelId: number): void {
  db.prepare(
    "UPDATE clips SET status = 'pending', reel_id = NULL WHERE reel_id = ? AND status = 'used'",
  ).run(reelId);
}

