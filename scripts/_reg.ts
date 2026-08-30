import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../src/ingest/probe.js';
import { compileReel } from '../src/video/compile.js';
import { config } from '../src/config.js';
import type { ClipRow } from '../src/types.js';

const dir = '.testdata/.repro/raw';
const files = fs.readdirSync(dir).filter((f) => /\.mp4$/i.test(f)).sort();
const clips: ClipRow[] = [];
let expected = 0;
for (const [i, f] of files.entries()) {
  const p = path.resolve(dir, f);
  const m = await probe(p);
  const capped = Math.min(m.videoDuration, config.video.maxClipSeconds);
  expected += Math.floor(capped * config.video.fps) / config.video.fps;
  clips.push({
    id: i + 1, message_id: `r${i}`, channel_id: 'c', guild_id: 'g', author_id: 'u', author_name: 'p',
    source_type: 'attachment', source_url: 'x', file_path: p, content_hash: null, phash: null,
    duration: m.duration, width: m.width, height: m.height, has_audio: m.hasAudio ? 1 : 0,
    status: 'pending', reel_id: null, note: null,
    message_at: new Date().toISOString(), created_at: new Date().toISOString(),
  });
}
expected -= (clips.length - 1) * config.video.transitionDuration;
const reel = await compileReel(7777, clips, 1);
const out = await probe(reel.videoPath);
console.log(`\nREAL ${clips.length} clips  reel ${out.videoDuration.toFixed(2)}s  expected ${expected.toFixed(2)}s  drift ${((out.videoDuration - expected) * 1000).toFixed(0)}ms`);
fs.rmSync(reel.videoPath, { force: true }); fs.rmSync(reel.thumbnailPath, { force: true });
setTimeout(() => process.exit(0), 50);
