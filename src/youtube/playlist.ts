import { config } from '../config.js';
import { kvGet, kvSet } from '../db/index.js';
import { logger } from '../logger.js';
import { missingFromPlaylist, updateReel } from '../db/reels.js';
import { youtubeClient } from './auth.js';
import { isRetryableUploadError } from './upload.js';

const RESOLVED_KEY = 'youtube:playlist_id';

/**
 * The playlist every reel is added to, or null when the feature is off.
 *
 * `YOUTUBE_PLAYLIST_ID` wins if set. Otherwise a playlist named
 * `YOUTUBE_PLAYLIST_TITLE` is found or created, and its id remembered — searching by
 * title on every upload would otherwise risk creating a second playlist with the same
 * name the first time a list call failed.
 */
export async function resolvePlaylistId(): Promise<string | null> {
  if (config.youtube.playlistId) return config.youtube.playlistId;
  if (!config.youtube.playlistTitle) return null;

  const remembered = kvGet(RESOLVED_KEY);
  if (remembered) return remembered;

  const youtube = youtubeClient();
  const title = config.youtube.playlistTitle;

  // 1 quota unit, against the 50 an accidental duplicate playlist would cost.
  const existing = await youtube.playlists.list({ part: ['snippet'], mine: true, maxResults: 50 });
  const match = existing.data.items?.find((p) => p.snippet?.title === title);

  if (match?.id) {
    kvSet(RESOLVED_KEY, match.id);
    logger.info({ playlist: title, id: match.id }, 'using existing playlist');
    return match.id;
  }

  const created = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description: 'Clips compiled from our Discord community.' },
      status: { privacyStatus: config.youtube.playlistPrivacy },
    },
  });

  const id = created.data.id;
  if (!id) throw new Error('YouTube did not return a playlist id');

  kvSet(RESOLVED_KEY, id);
  logger.info({ playlist: title, id }, 'created playlist');
  return id;
}

/**
 * Adds one uploaded reel to the playlist and records that it happened.
 *
 * Never throws: a reel that is on YouTube but missing from the playlist is a cosmetic
 * problem, and failing the pipeline over it would strand clips that are already
 * published. `syncPlaylist` picks up anything that did not make it.
 */
export async function addReelToPlaylist(reelId: number, videoId: string): Promise<boolean> {
  const playlistId = await resolvePlaylistId().catch((err: Error) => {
    logger.warn({ err: err.message }, 'could not resolve the playlist');
    return null;
  });
  if (!playlistId) return false;

  try {
    const res = await youtubeClient().playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
      },
    });

    updateReel(reelId, { playlist_item_id: res.data.id ?? 'added' });
    logger.info({ reelId, playlistId }, 'added reel to playlist');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { reelId, err: message, retryable: isRetryableUploadError(err) },
      'could not add the reel to the playlist',
    );
    return false;
  }
}

/**
 * Adds every uploaded reel that is not in the playlist yet.
 *
 * Runs on the same hourly sweep as the upload retries, which means turning the feature
 * on backfills videos uploaded before it existed, without a separate command.
 */
export async function syncPlaylist(): Promise<number> {
  if (!config.youtube.enabled) return 0;
  if (!config.youtube.playlistId && !config.youtube.playlistTitle) return 0;

  const pending = missingFromPlaylist();
  if (pending.length === 0) return 0;

  let added = 0;
  for (const reel of pending) {
    if (await addReelToPlaylist(reel.id, reel.youtube_id!)) added++;
  }

  if (added > 0) logger.info({ added, of: pending.length }, 'playlist synced');
  return added;
}
