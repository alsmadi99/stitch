/**
 * Container healthcheck: passes only while the bot is refreshing its heartbeat.
 * Exits 1 when the file is missing or stale so Docker restarts the container.
 */
import { HEARTBEAT_MAX_AGE_MS, heartbeatAgeMs } from '../src/heartbeat.js';

const age = heartbeatAgeMs();

if (age === null) {
  console.error('no heartbeat file yet');
  process.exit(1);
}

if (age > HEARTBEAT_MAX_AGE_MS) {
  console.error(`heartbeat is ${Math.round(age / 1000)}s old`);
  process.exit(1);
}

process.exit(0);
