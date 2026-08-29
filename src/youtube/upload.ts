import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { youtubeClient } from './auth.js';

export interface UploadInput {
  videoPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
}

export interface UploadResult {
  videoId: string;
  url: string;
  privacy: string;
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

  logger.info({ title: input.title, sizeMb: Math.round(size / 1_048_576) }, 'uploading to youtube');

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: false,
      requestBody: {
        snippet: {
          title: input.title,
          description: input.description,
          tags: [...config.youtube.tags],
          categoryId: config.youtube.categoryId,
        },
        status: {
          privacyStatus: config.youtube.privacy,
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
    privacy: res.data.status?.privacyStatus ?? config.youtube.privacy,
  };
}

/** Used by the Discord approve button to take a private upload public. */
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
