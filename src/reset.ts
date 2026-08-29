import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db/index.js';
import { logger } from './logger.js';

export interface ResetSummary {
  clips: number;
  reels: number;
  files: number;
  megabytes: number;
}

/** What a reset is about to destroy, so it can be shown before anything is deleted. */
export function describeState(): { clips: number; reels: number; published: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
  return {
    clips: one('SELECT COUNT(*) AS n FROM clips'),
    reels: one('SELECT COUNT(*) AS n FROM reels'),
    published: one("SELECT COUNT(*) AS n FROM reels WHERE youtube_id IS NOT NULL"),
  };
}

/**
 * Wipes every trace of previous runs: the clip queue, the reel history, the backfill
 * cursor, and all downloaded and generated files.
 *
 * This does not and cannot touch YouTube. The record of which clips were already
 * published lives only in this database, so after a reset the bot has no way to know —
 * a subsequent backfill will re-upload clips that are already on the channel. That is
 * the whole cost of this operation and the reason it is gated behind an explicit flag.
 *
 * The heartbeat and compile lock are left alone; they describe the running process,
 * not the work.
 */
export async function resetState(): Promise<ResetSummary> {
  const before = describeState();

  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM clips').run();
    db.prepare('DELETE FROM reels').run();
    db.prepare('DELETE FROM kv').run();
    // Restart ids (and therefore episode numbering) from 1 rather than continuing.
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('clips', 'reels')").run();
  });
  wipe();

  let files = 0;
  let bytes = 0;

  for (const dir of [config.paths.rawDir, config.paths.workDir, config.paths.outDir]) {
    for (const entry of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, entry);
      const size = await fsp
        .stat(full)
        .then((s) => s.size)
        .catch(() => 0);
      await fsp.rm(full, { recursive: true, force: true }).catch(() => undefined);
      files++;
      bytes += size;
    }
  }

  const summary: ResetSummary = {
    clips: before.clips,
    reels: before.reels,
    files,
    megabytes: Math.round(bytes / 1_048_576),
  };

  logger.warn(summary, 'state reset');
  return summary;
}
