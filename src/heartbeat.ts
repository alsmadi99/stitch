import fs from 'node:fs';
import path from 'node:path';

/**
 * Deliberately does not import config: the container healthcheck runs this every 60
 * seconds, and booting dotenv plus the whole zod schema each time is wasted work. It
 * also means a misconfigured .env surfaces as a bot failure rather than as a confusing
 * healthcheck crash.
 */
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || './data');
const HEARTBEAT_FILE = path.join(dataDir, 'heartbeat');

/** Stale for longer than this and the container is considered unhealthy. */
export const HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

/**
 * Touched while the Discord gateway is connected. The process staying alive is not
 * proof it is working — a wedged websocket leaves it running and deaf — so the
 * healthcheck watches this file's age rather than the process table.
 */
export function beat(): void {
  try {
    fs.writeFileSync(HEARTBEAT_FILE, new Date().toISOString());
  } catch {
    // A failed heartbeat write must never take the bot down with it.
  }
}

export function heartbeatAgeMs(): number | null {
  try {
    return Date.now() - fs.statSync(HEARTBEAT_FILE).mtimeMs;
  } catch {
    return null;
  }
}
