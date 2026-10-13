import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TOOL, run, probe, convert, uploadAudio, verify } from '../lib/converter.mjs';
import { createApp } from '../server.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-media-test-'));
const input = path.join(root, 'sample.mp4');
test.before(async () => {
  await run(TOOL.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
});
test.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

for (const format of ['webm', 'mp4']) test(`real MP4 with audio → verified silent ${format}`, async () => {
  const info = await probe(input); assert.equal(info.hasAudio, true);
  const result = await convert({ source: input, name: 'My clip.mp4', info, options: { format }, outputDir: path.join(root, format) });
  assert.equal(result.length, 1); assert.ok(result[0].verified); assert.equal(result[0].audio, false);
  assert.ok(result[0].bytes < 4_000_000); assert.equal(result[0].width, 320); assert.equal(result[0].height, 180);
  await verify(result[0].path, format, info.duration);
});

test('MOV, MKV, AVI and WebM inputs are supported', async () => {
  for (const extension of ['mov', 'mkv', 'avi', 'webm']) {
    const source = path.join(root, `source.${extension}`);
    await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', input, '-an', '-c:v', extension === 'webm' ? 'libvpx-vp9' : extension === 'avi' ? 'mpeg4' : 'libx264', source]);
    const info = await probe(source);
    const output = await convert({ source, name: `source.${extension}`, info, options: { format: 'mp4' }, outputDir: path.join(root, extension + '-input') });
    assert.ok(output[0].verified);
  }
});

test('long video splits completely; each part uploads only its matching audio (mock service)', async () => {
  const source = path.join(root, 'long.mp4');
  await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=64x48:rate=2:duration=121', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=121', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source]);
  const info = await probe(source); const uploads = [];
  const uploader = async file => {
    const raw = JSON.parse(await run(TOOL.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', file]));
    uploads.push(Number(raw.format.duration)); return `https://files.catbox.moe/part${uploads.length}.mp3`;
  };
  const result = await convert({ source, name: 'long.mp4', info, options: { catbox: true, prefix: 'audio_', suffix: '_link' }, outputDir: path.join(root, 'long-output'), uploader });
  assert.equal(result.length, 2); assert.equal(uploads.length, 2);
  assert.ok(result.every(o => o.duration <= 120 && o.bytes < 4_000_000 && o.audioUrl && o.audioPath));
  assert.ok(Math.abs(result.reduce((sum, o) => sum + o.duration, 0) - 121) < .1);
  assert.ok(uploads.every(d => Math.abs(d - 60.5) < .1));
  assert.match(result[1].name, /^audio_.*_part-02_link.webm$/);
});

test('Catbox multipart request matches documented contract without live publication', async () => {
  const mp3 = path.join(root, 'test.mp3'); await fs.writeFile(mp3, 'test-audio');
  const url = await uploadAudio(mp3, 'userhash123', undefined, async (target, init) => {
    assert.equal(target, 'https://catbox.moe/user/api.php'); assert.equal(init.method, 'POST');
    assert.equal(init.body.get('reqtype'), 'fileupload'); assert.equal(init.body.get('userhash'), 'userhash123');
    assert.equal(init.body.get('fileToUpload').type, 'audio/mpeg'); assert.equal(await init.body.get('fileToUpload').text(), 'test-audio');
    return new Response('https://files.catbox.moe/abcdef.mp3');
  });
  assert.equal(url, 'https://files.catbox.moe/abcdef.mp3');
  await assert.rejects(uploadAudio(mp3, '', undefined, async () => new Response('failed', { status: 503 })), /503/);
});

test('upload failure preserves validated video and local MP3', async () => {
  const result = await convert({ source: input, name: 'clip.mp4', info: await probe(input), options: { catbox: true }, outputDir: path.join(root, 'failure'), uploader: async () => { throw new Error('Simulated offline service'); } });
  assert.ok((await fs.stat(result[0].path)).size > 0); assert.ok((await fs.stat(result[0].audioPath)).size > 0);
  assert.match(result[0].warning, /Simulated offline service/); assert.equal(result[0].audioUrl, '');
});

test('silent source with Catbox enabled remains convertible', async () => {
  const source = path.join(root, 'silent.mp4');
  await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', input, '-an', '-c:v', 'copy', source]);
  const result = await convert({ source, name: 'silent.mp4', info: await probe(source), options: { catbox: true }, outputDir: path.join(root, 'silent-output'), uploader: () => assert.fail('A silent source must not be uploaded.') });
  assert.match(result[0].warning, /no audio/); assert.ok(result[0].verified);
});

test('rotated phone video is converted with the displayed orientation', async () => {
  const source = path.join(root, 'rotated.mp4');
  await run(TOOL.ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-display_rotation', '90', '-i', input, '-c', 'copy', source]);
  const rotationProbe = JSON.parse(await run(TOOL.ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', source]));
  assert.equal(Math.abs(rotationProbe.streams[0].side_data_list.find(s => s.rotation !== undefined).rotation), 90);
  const result = await convert({ source, name: 'phone.mp4', info: await probe(source), options: {}, outputDir: path.join(root, 'rotated-output') });
  assert.equal(result[0].width, 180); assert.equal(result[0].height, 320);
});

test('HTTP import → batch → verified downloads and ZIP, plus broken-input rejection', async () => {
  const app = await createApp({ outputRoot: path.join(root, 'http-output') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/`;
  const headers = { 'X-Frame-Token': app.token };
  const request = (endpoint, options = {}) => fetch(base + endpoint, { ...options, headers: { ...headers, ...options.headers } });
  try {
    assert.equal((await request('files?name=broken.mp4', { method: 'POST', body: Buffer.from('broken video') })).status, 400);
    const uploaded = await request('files?name=clip.mp4', { method: 'POST', body: await fs.readFile(input) });
    assert.equal(uploaded.status, 201); const item = await uploaded.json();
    const response = await request('convert', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [item.id], options: { format: 'mp4' } }) });
    assert.equal(response.status, 202);
    let current; const deadline = Date.now() + 120_000;
    do { await new Promise(r => setTimeout(r, 100)); current = await (await request('state')).json(); } while (current.batch.active && Date.now() < deadline);
    assert.equal(current.files[0].state, 'done', JSON.stringify(current));
    const output = current.files[0].outputs[0];
    const downloaded = await request(`download?id=${output.id}`);
    assert.equal(downloaded.status, 200); assert.equal((await downloaded.arrayBuffer()).byteLength, output.bytes);
    const zip = await request('archive'); assert.equal(zip.status, 200); assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(), 0x04034b50);
    const manifest = JSON.parse(await fs.readFile(path.join(current.batch.outputDir, 'conversion-report.json'), 'utf8'));
    assert.equal(manifest.files[0].outputs[0].verified, true);
    await request('clear', { method: 'POST' }); assert.equal((await (await request('state')).json()).files.length, 0);
    assert.ok((await fs.stat(path.join(current.batch.outputDir, output.name))).size > 0);
  } finally { await app.close(); }
});
