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
