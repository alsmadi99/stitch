export type ClipStatus = 'pending' | 'used' | 'duplicate' | 'rejected' | 'failed';
export type ReelStatus = 'building' | 'ready' | 'uploading' | 'uploaded' | 'published' | 'failed';
export type SourceType = 'attachment' | 'link';

export interface ClipRow {
  id: number;
  message_id: string;
  channel_id: string;
  guild_id: string | null;
  author_id: string;
  author_name: string;
  source_type: SourceType;
  source_url: string;
  file_path: string | null;
  content_hash: string | null;
  phash: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  has_audio: number;
  status: ClipStatus;
  reel_id: number | null;
  note: string | null;
  message_at: string;
  created_at: string;
}

export interface ReelRow {
  id: number;
  status: ReelStatus;
  clip_count: number;
  video_path: string | null;
  thumbnail_path: string | null;
  youtube_id: string | null;
  youtube_url: string | null;
  title: string | null;
  error: string | null;
  created_at: string;
  published_at: string | null;
}

/** A clip candidate extracted from a Discord message, before download. */
export interface Candidate {
  messageId: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  sourceType: SourceType;
  sourceUrl: string;
  messageAt: Date;
}
