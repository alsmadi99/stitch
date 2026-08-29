/**
 * Ingest clips already sitting in the channel.
 * Usage: npm run backfill -- 1000
 */
import { logger } from '../src/logger.js';
import { client, login } from '../src/discord/client.js';
import { backfill } from '../src/discord/collector.js';

const limit = Number(process.argv[2] ?? 500);

await login();
const stats = await backfill(client, limit);
logger.info(stats, 'backfill complete');
await client.destroy();
process.exit(0);
