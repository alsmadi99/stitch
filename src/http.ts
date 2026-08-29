import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { countPending } from './db/clips.js';
import { latestReel } from './db/reels.js';
import { isCompilingAnywhere } from './pipeline.js';
import { readJobState } from './jobs.js';

/**
 * A tiny status endpoint. The bot is a worker with no web surface of its own, but a
 * platform like Dokploy wants something to route a domain at and poll for health.
 *
 * Deliberately exposes no clip URLs, member names, or configuration — anything served
 * here is reachable by whoever finds the hostname.
 */
/** Compact view of the backfill job for /health; omits the long summary text. */
function jobSummary(): Record<string, unknown> | null {
  const state = readJobState();
  if (!state) return null;
  return {
    status: state.status,
    startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    ...(state.progress ?? {}),
  };
}

export function startHttpServer(isConnected: () => boolean): http.Server | null {
  if (config.http.port <= 0) {
    logger.info('HTTP status endpoint disabled (HTTP_PORT=0)');
    return null;
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/health' || url === '/healthz') {
      const connected = isConnected();
      res.writeHead(connected ? 200 : 503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: connected ? 'ok' : 'disconnected',
          uptimeSeconds: Math.round(process.uptime()),
          discord: connected,
          compiling: isCompilingAnywhere(),
          queued: countPending(),
          lastReel: latestReel()?.status ?? null,
          backfill: jobSummary(),
        }),
      );
      return;
    }

    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('clipreel\n');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  });

  server.listen(config.http.port, '0.0.0.0', () => {
    logger.info({ port: config.http.port }, 'status endpoint listening');
  });

  server.on('error', (err) => logger.error({ err: err.message }, 'http server error'));

  return server;
}
