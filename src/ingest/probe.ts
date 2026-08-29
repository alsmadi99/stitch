import { ffprobe } from '../video/ffmpeg.js';

export interface ProbeResult {
  duration: number;
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

  return {
    duration,
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? null,
  };
}
