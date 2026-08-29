/**
 * Compile (and upload) a reel from whatever is queued, without waiting for the
 * threshold or the weekly cron. Useful for a first end-to-end test.
 *
 * Usage: npm run reel:now
 */
import { logger } from '../src/logger.js';
import { client, login } from '../src/discord/client.js';
import { runPipeline } from '../src/pipeline.js';

// The pipeline announces the result in Discord, so it needs a live gateway connection.
await login();

try {
  const result = await runPipeline('manual');
  logger.info(result, 'run finished');
} finally {
  await client.destroy();
}

process.exit(0);
