import pino from 'pino';
import { config } from './config.js';

// A long backfill is usually started from an interactive container shell. When that
// terminal is closed the pty goes away, and the next write to stdout raises EPIPE or
// EIO — which, unhandled, is an uncaught error that kills a job midway through. Losing
// hours of downloading because a browser tab was closed is not an acceptable failure
// mode, so those two errors are swallowed; there is nowhere left to report them anyway.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE' && err.code !== 'EIO') throw err;
  });
}

export const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});

export type Logger = typeof logger;
