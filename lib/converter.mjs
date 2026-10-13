import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { outputName, validateCatboxUrl, validateOptions } from './naming.mjs';

export const PROFILE = Object.freeze({ board: '/pol/', maxBytes: 4_000_000, boardMaxBytes: 4_194_304,
  targetBytes: 3_800_000, maxDuration: 120, segmentDuration: 119, maxDimension: 2048,
  checked: '2026-10-13', source: 'https://a.4cdn.org/boards.json' });
export const EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.mpeg', '.mpg', '.mts', '.m2ts', '.ts', '.wmv', '.flv', '.ogv', '.3gp', '.vob']);
export const TOOL = { ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe' };

export function run(program, args, { signal, onLine, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    const child = spawn(program, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', lineBuffer = '', settled = false, timedOut = false;
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeout ? setTimeout(() => { timedOut = true; abort(); }, timeout) : null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? `${path.basename(program)} was not found. Install FFmpeg and restart Frame.` : error.message)));
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-2_000_000);
      if (onLine) {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split(/\r?\n/); lineBuffer = lines.pop(); lines.forEach(onLine);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-6000); });
    child.on('close', code => {
      if (signal?.aborted) return finish(new Error('Cancelled.'));
      if (timedOut) return finish(new Error(`${path.basename(program)} timed out.`));
      if (code !== 0) return finish(new Error(stderr.trim() || `${path.basename(program)} exited with code ${code}.`));
      finish(null, stdout);
    });
  });
}

export async function dependencies() {
  try {
    const [version, encoders] = await Promise.all([run(TOOL.ffprobe, ['-version'], { timeout: 10_000 }), run(TOOL.ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10_000 })]);
    const missing = ['libvpx-vp9', 'libx264', 'libmp3lame'].filter(codec => !encoders.includes(codec));
    return { ready: !missing.length, version: version.split('\n')[0], error: missing.length ? `FFmpeg is missing: ${missing.join(', ')}. Install a full FFmpeg build.` : '' };
  } catch (error) { return { ready: false, error: error.message }; }
}

const rate = value => {
  const [a, b = 1] = String(value || '0').split('/').map(Number);
  return b && Number.isFinite(a / b) ? a / b : 0;
};

export async function probe(file, signal) {
  const raw = JSON.parse(await run(TOOL.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { signal, timeout: 60_000 }));
  const videos = (raw.streams || []).filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const video = videos[0];
  if (!video) throw new Error('No readable video stream was found in this file.');
  const duration = Number(video.duration || raw.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !video.width || !video.height) throw new Error('The video has no usable duration or dimensions.');
  return { duration, width: video.width, height: video.height, fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate) || 30,
    codec: video.codec_name, pixelFormat: video.pix_fmt, videoIndex: video.index,
    hasAudio: raw.streams.some(s => s.codec_type === 'audio'), streams: raw.streams,
    format: raw.format.format_name, bytes: Number(raw.format.size), sar: video.sample_aspect_ratio || '1:1' };
}

export function segments(duration, policy = 'split') {
  if (duration <= PROFILE.segmentDuration) return [{ start: 0, duration }];
  if (policy === 'reject') {
    if (duration <= PROFILE.maxDuration - 0.1) return [{ start: 0, duration }];
    throw new Error('This video is too long. Enable automatic splitting to keep the entire video.');
  }
  // Equal segments avoid a nearly empty final clip.
  const count = Math.ceil(duration / PROFILE.segmentDuration);
  const size = duration / count;
  return Array.from({ length: count }, (_, i) => ({ start: i * size, duration: Math.min(size, duration - i * size) }));
}

export function encodingProfile(bitrate, sourceFps = 30) {
  const [side, fps] = bitrate >= 1_800_000 ? [1280, 30] : bitrate >= 850_000 ? [960, 30]
    : bitrate >= 600_000 ? [720, 30] : bitrate >= 400_000 ? [640, 24]
    : bitrate >= 275_000 ? [540, 24] : bitrate >= 190_000 ? [480, 20] : [360, 18];
  return { side, fps: Math.max(1, Math.min(sourceFps, fps)) };
}

export async function verify(file, format, expectedDuration, signal) {
  const info = await probe(file, signal);
  const issues = [];
  if (info.streams.length !== 1 || info.hasAudio) issues.push('Output must contain exactly one video stream and no audio.');
  if (info.codec !== (format === 'webm' ? 'vp9' : 'h264')) issues.push('Unexpected video codec.');
  if (!(format === 'webm' ? info.format.includes('webm') : info.format.includes('mp4'))) issues.push('Unexpected container.');
  if (info.pixelFormat !== 'yuv420p') issues.push('Output must use 8-bit yuv420p.');
  if (info.bytes <= 0 || info.bytes >= PROFILE.maxBytes) issues.push('Output exceeds the size target.');
  if (info.duration > PROFILE.maxDuration || info.duration <= 0) issues.push('Output exceeds the duration limit.');
  if (Math.abs(info.duration - expectedDuration) > Math.max(0.3, 2 / info.fps)) issues.push('Output duration does not match the selected clip.');
  if (info.width < 2 || info.height < 2 || info.width > PROFILE.maxDimension || info.height > PROFILE.maxDimension) issues.push('Output dimensions are outside the allowed range.');
  if (info.fps > 30.1 || info.width % 2 || info.height % 2) issues.push('Unexpected frame rate or odd dimensions.');
  if (issues.length) throw new Error(issues.join(' '));
  // Probe validates metadata; a full decode also detects broken/truncated frames.
  await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', os.devNull], { signal, timeout: 120_000 });
  return { bytes: info.bytes, duration: info.duration, width: info.width, height: info.height, fps: info.fps, codec: info.codec, audio: false, verified: true };
}

async function encode(source, info, segment, out, format, work, signal, progress) {
  let bitrate = Math.floor(PROFILE.targetBytes * 8 * 0.94 / segment.duration);
  for (let attempt = 0; attempt < 5; attempt++) {
    const profile = encodingProfile(bitrate, info.fps);
    // Normalize sample aspect ratio before fitting; FFmpeg autorotates phone video.
    const vf = `scale=w='max(2,trunc(iw*sar/2)*2)':h=ih,setsar=1,scale=w='min(iw,${profile.side})':h='min(ih,${profile.side})':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=width='max(2,iw)':height='max(2,ih)',fps=${profile.fps},format=yuv420p`;
    const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(segment.start), '-i', source,
      '-t', String(segment.duration), '-map', `0:${info.videoIndex}`, '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', vf, '-c:v', format === 'webm' ? 'libvpx-vp9' : 'libx264', '-b:v', String(bitrate), '-pix_fmt', 'yuv420p',
      '-threads', String(Math.max(1, Math.min(8, os.availableParallelism() - 1))), '-passlogfile', path.join(work, 'pass'), '-progress', 'pipe:1', '-nostats'];
    if (format === 'webm') common.push('-deadline', 'good', '-cpu-used', '4', '-row-mt', '1');
    else common.push('-preset', 'medium', '-profile:v', 'high');
    for (let pass = 1; pass <= 2; pass++) {
      progress((pass - 1) / 2, `Pass ${pass} of 2${attempt ? ` · size adjustment ${attempt}` : ''}`);
      const args = [...common, '-pass', String(pass)];
      if (pass === 1) args.push('-f', 'null', os.devNull);
      else {
        if (format === 'mp4') args.push('-movflags', '+faststart');
        args.push('-f', format, out);
      }
      await run(TOOL.ffmpeg, args, { signal, onLine: line => {
        if (line.startsWith('out_time_us=')) {
          const value = Math.max(0, Math.min(1, Number(line.slice(12)) / 1e6 / segment.duration));
          progress((pass - 1 + value) / 2, `Pass ${pass} of 2${attempt ? ` · size adjustment ${attempt}` : ''}`);
        }
      } });
    }
    const bytes = (await fs.stat(out)).size;
    if (bytes < PROFILE.maxBytes) return verify(out, format, segment.duration, signal);
    bitrate = Math.max(10_000, Math.floor(bitrate * PROFILE.targetBytes / bytes * 0.9));
  }
  throw new Error('Could not fit this clip below 4 MB after five attempts.');
}

export async function uploadAudio(file, userhash, signal, fetcher = fetch) {
  const form = new FormData();
  form.set('reqtype', 'fileupload');
  if (userhash) form.set('userhash', userhash);
  form.set('fileToUpload', new Blob([await fs.readFile(file)], { type: 'audio/mpeg' }), 'audio.mp3');
  const response = await fetcher('https://catbox.moe/user/api.php', { method: 'POST', body: form,
    signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(120_000)]), redirect: 'error' });
  if (!response.ok) throw new Error(`Catbox returned HTTP ${response.status}.`);
  const result = (await response.text()).trim();
  return validateCatboxUrl(result);
}

async function uniqueCopy(source, directory, name) {
  const parsed = path.parse(name);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(directory, i ? `${parsed.name}_${i + 1}${parsed.ext}` : name);
    try { await fs.copyFile(source, candidate, 1); return candidate; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('Too many files have the same output name.');
}

export async function convert({ source, name, info, options: rawOptions, outputDir, signal, onProgress = () => {}, onOutput = () => {}, uploader = uploadAudio }) {
  const options = validateOptions(rawOptions);
  const chunks = segments(info.duration, options.longVideo);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-encode-'));
  const outputs = [];
  await fs.mkdir(outputDir, { recursive: true });
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (signal?.aborted) throw new Error('Cancelled.');
      const chunk = chunks[i];
      const tempVideo = path.join(work, `output.${options.format}`);
      const details = await encode(source, info, chunk, tempVideo, options.format, work, signal, (p, stage) => onProgress((i + p * 0.87) / chunks.length, `${chunks.length > 1 ? `Part ${i + 1}/${chunks.length} · ` : ''}${stage}`));
      // Save validated video before any network work. A failed upload cannot lose it.
      const baseName = outputName({ ...options, name, part: i, total: chunks.length,
        randomName: options.naming === 'random' ? randomBytes(8).toString('hex') : '' });
      let savedPath = await uniqueCopy(tempVideo, outputDir, baseName);
      const output = { id: randomBytes(10).toString('hex'), path: savedPath, name: path.basename(savedPath), ...details,
        part: i + 1, total: chunks.length, start: chunk.start, audioUrl: '', audioPath: '', warning: '' };
      if (options.catbox && info.hasAudio) {
        const audio = path.join(work, 'audio.mp3');
        onProgress((i + 0.9) / chunks.length, 'Extracting audio');
        try {
          await run(TOOL.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(chunk.start), '-i', source,
            '-t', String(chunk.duration), '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ac', '2', '-map_metadata', '-1', audio], { signal });
          output.audioPath = await uniqueCopy(audio, path.join(outputDir), `${path.parse(baseName).name}.mp3`);
          onProgress((i + 0.94) / chunks.length, 'Uploading audio to Catbox');
          output.audioUrl = await uploader(audio, options.userhash, signal);
          const linkedName = outputName({ ...options, name, url: output.audioUrl, part: i, total: chunks.length });
          const linkedPath = await uniqueCopy(savedPath, outputDir, linkedName);
          await fs.unlink(savedPath);
          savedPath = linkedPath;
          output.path = linkedPath; output.name = path.basename(linkedPath);
        } catch (error) {
          output.warning = signal?.aborted ? 'Audio upload interrupted. The verified video and any extracted audio are saved.' : `Audio link unavailable: ${error.message} The verified video is saved.`;
        }
      } else if (options.catbox) output.warning = 'Source has no audio. Saved a silent video without an audio link.';
      outputs.push(output);
      await onOutput(output);
      onProgress((i + 1) / chunks.length, 'Verified');
      if (signal?.aborted) throw new Error('Cancelled.');
    }
    return outputs;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
