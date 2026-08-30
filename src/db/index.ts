import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.paths.dbFile);

// schema.sql sits next to this file under src/. tsc does not copy non-TS files into
// dist/, so a compiled build falls back to reading it from the source tree.
const schemaPath = [
  path.join(here, 'schema.sql'),
  path.join(process.cwd(), 'src/db/schema.sql'),
].find((p) => fs.existsSync(p));

if (!schemaPath) throw new Error('db/schema.sql not found');

db.exec(fs.readFileSync(schemaPath, 'utf8'));

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing for a database that already exists, so new
 * columns have to be added explicitly. Adding a nullable or defaulted column is the one
 * schema change SQLite does cheaply and safely, which is why migrations here are
 * limited to that shape.
 */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info({ table, column }, 'migrated: added column');
}

ensureColumn('reels', 'description', 'TEXT');
ensureColumn('reels', 'upload_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('reels', 'next_attempt_at', 'TEXT');
ensureColumn('reels', 'playlist_item_id', 'TEXT');

logger.debug({ file: config.paths.dbFile }, 'sqlite ready');

export function kvGet(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(key: string, value: string): void {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
