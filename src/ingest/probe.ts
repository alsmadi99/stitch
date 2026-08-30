import { ffprobe } from '../video/ffmpeg.js';

export interface ProbeResult {
  /** Container duration — the longest stream. Use `videoDuration` for timing decisions. */
  duration: number;
  /**
   * Length of the picture itself, with any leading timestamp offset removed.
   *
   * Screen recorders routinely emit audio a little longer than video, and the container
   * reports the longer of the two. Timing a reel off that number asks ffmpeg for
   * picture that does not exist, and it fills the gap by freezing the last frame.
   *
   * ffprobe derives a stream's `duration` from its timestamps, so a file that does not
   * start at zero reports its content plus the offset. Subtracting `start_time` is what
   * makes this a length rather than an end position.
   */
  videoDuration: number;
  audioDuration: number;
  /** Timestamp the picture starts at. Reading the whole file means seeking past this. */
  videoStart: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  start_time?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await ffprobe([
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);

  const data = JSON.parse(stdout.toString('utf8')) as FfprobeOutput;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) throw new Error('file has no video stream');

  const duration = Number(data.format?.duration ?? video.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('could not determine duration');

  // Matroska and some webm files carry no per-stream duration; fall back to the
  // container rather than reporting zero.
  const streamDuration = (value: string | undefined): number => {
    const n = Number(value ?? NaN);
    return Number.isFinite(n) && n > 0 ? n : duration;
  };

  const startTime = (stream: FfprobeStream): number => {
    const n = Number(stream.start_time ?? NaN);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  /** End timestamp minus start timestamp: how much picture or sound actually exists. */
  const contentLength = (stream: FfprobeStream): number =>
    Math.max(0, streamDuration(stream.duration) - startTime(stream));

  return {
    duration,
    videoDuration: contentLength(video),
    audioDuration: audio ? contentLength(audio) : 0,
    videoStart: startTime(video),
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
  };
}
