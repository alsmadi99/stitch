import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { youtubeClient } from './auth.js';

export interface UploadInput {
  videoPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
  tags: string[];
  /**
   * Overrides the configured privacy for this one upload.
   *
   * A rebuild wants to go up private for review even on a channel that publishes
   * automatically, so the decision has to be per-upload rather than per-config.
   */
  privacy?: 'private' | 'unlisted' | 'public';
}

export interface UploadResult {
  videoId: string;
  url: string;
  privacy: string;
}

/**
 * The privacy a new upload is created with.
 *
 * `YOUTUBE_AUTO_PUBLISH=false` now genuinely means "do not publish": the upload is
 * forced private regardless of `YOUTUBE_PRIVACY`, and going public is a separate,
 * deliberate act. Previously the two settings looked related but were not — a config of
 * `PRIVACY=public` with `AUTO_PUBLISH=false` read as safe and published everything the
 * moment it was uploaded.
 */
export function uploadPrivacy(): 'private' | 'unlisted' | 'public' {
  return config.youtube.autoPublish ? config.youtube.privacy : 'private';
}

/**
 * Resumable upload of the finished reel.
 *
 * Note: a Google Cloud project that has not passed API verification can only create
 * *private* videos — the API accepts `public` and silently locks the video. Ask for
 * an audit, or flip the video to public in Studio after the fact.
 */
export async function uploadReel(input: UploadInput): Promise<UploadResult> {
  const youtube = youtubeClient();
  const size = fs.statSync(input.videoPath).size;
  const privacy = input.privacy ?? uploadPrivacy();

  logger.info(
    { title: input.title, sizeMb: Math.round(size / 1_048_576), privacy },
    'uploading to youtube',
  );

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: false,
      requestBody: {
        snippet: {
          title: input.title,
          description: input.description,
          tags: input.tags,
          categoryId: config.youtube.categoryId,
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(input.videoPath) },
    },
    {
      // googleapis switches to a resumable session when the body is a stream; this
      // callback is the only progress signal it exposes.
      onUploadProgress: (evt: { bytesRead: number }) => {
        const pct = Math.round((evt.bytesRead / size) * 100);
        if (pct % 10 === 0) logger.debug({ pct }, 'upload progress');
      },
    },
  );

  const videoId = res.data.id;
  if (!videoId) throw new Error('YouTube did not return a video id');

  if (input.thumbnailPath && fs.existsSync(input.thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { body: fs.createReadStream(input.thumbnailPath) },
      });
    } catch (err) {
      // Custom thumbnails need a verified channel; not worth failing the whole run over.
      logger.warn({ err: (err as Error).message }, 'thumbnail upload failed');
    }
  }

  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    privacy: res.data.status?.privacyStatus ?? privacy,
  };
}

/**
 * YouTube allows 10,000 quota units a day and charges 1,600 for an upload, so the
 * seventh upload in 24 hours fails. Recognising it lets a long backfill stop cleanly
 * and resume tomorrow instead of burning through the rest of the queue on errors.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const record = err as { errors?: { reason?: string }[]; code?: number; message?: string };
  const reasons = record.errors?.map((e) => e.reason ?? '') ?? [];
  if (reasons.some((r) => /quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(r))) return true;
  return /quota|dailyLimit/i.test(record.message ?? '');
}

/**
 * Whether a failed upload is worth trying again later.
 *
 * Quota exhaustion, rate limits, 5xx responses and dropped connections all say
 * "not now" rather than "not ever" — the video is fine, only the transport failed.
 * A rejected video (bad metadata, forbidden, unauthorized) will fail identically
 * forever, so retrying it just burns quota.
 */
export function isRetryableUploadError(err: unknown): boolean {
  if (isQuotaError(err)) return true;

  const record = err as { code?: number | string; message?: string; status?: number };
  const status = typeof record.code === 'number' ? record.code : record.status;
  if (typeof status === 'number' && status >= 500) return true;

  const code = typeof record.code === 'string' ? record.code : '';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|ERR_STREAM/i.test(code)) {
    return true;
  }

  return /socket hang up|network|timeout|backend error|internal error/i.test(record.message ?? '');
}

/** Manual escape hatch for taking a private upload public. */
export async function setPrivacy(
  videoId: string,
  privacy: 'private' | 'unlisted' | 'public',
): Promise<void> {
  const youtube = youtubeClient();
  await youtube.videos.update({
    part: ['status'],
    requestBody: { id: videoId, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } },
  });
  logger.info({ videoId, privacy }, 'privacy updated');
}
