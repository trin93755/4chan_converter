import { promises as fs } from 'node:fs';
import { run, TOOL } from '../lib/converter.mjs';
await fs.mkdir('test-results/fixtures', { recursive: true });
await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'test-results/fixtures/Color study.mp4']);
await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'test-results/fixtures/Portrait study.mov']);
console.log('Synthetic browser-test videos created.');
