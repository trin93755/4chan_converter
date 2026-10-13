import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { encodeLink, outputName, sourceStem, validateOptions, validateCatboxUrl } from '../lib/naming.mjs';
import { segments, encodingProfile, run } from '../lib/converter.mjs';
import { writeZip } from '../lib/zip.mjs';
import { createApp } from '../server.mjs';

const url = 'https://files.catbox.moe/abcdef.mp3';
test('all offered filename encodings round-trip the original URL', () => {
  assert.equal(Buffer.from(encodeLink(url, 'base64url'), 'base64url').toString(), url);
  assert.equal(Buffer.from(decodeURIComponent(encodeLink(url, 'base64')), 'base64').toString(), url);
  assert.equal(decodeURIComponent(encodeLink(url, 'utf8')), url);
  assert.equal(decodeURIComponent(encodeLink(url, 'percent')), url);
  assert.equal(Buffer.from(encodeLink(url, 'hex'), 'hex').toString(), url);
  for (const encoding of ['base64url', 'base64', 'utf8', 'percent', 'hex']) assert.doesNotMatch(encodeLink(url, encoding), /[<>:"/\\|?*]/);
});
test('prefixes, suffixes and parts stay outside the encoded URL', () => {
  assert.equal(outputName({ name: 'test.mov', url, prefix: 'audio_', suffix: '_sound', format: 'mp4', part: 1, total: 3 }), `audio_${encodeLink(url, 'base64url')}_part-02_sound.mp4`);
  assert.match(outputName({ name: 'clip.mp4', url, includeSource: true }), /^clip_/);
});
test('hostile, reserved and long names are handled without breaking encoded URLs', () => {
  assert.equal(sourceStem('../../CON.mp4'), 'video_CON');
  assert.equal(outputName({ name: '../strange:name?.mp4' }), 'strange_name_.webm');
  assert.throws(() => outputName({ prefix: '../' }), /Prefixes/);
  assert.throws(() => outputName({ prefix: 'a'.repeat(41) }), /Prefixes/);
  assert.throws(() => outputName({ name: 'a'.repeat(65), includeSource: true, url: `https://files.catbox.moe/${'a'.repeat(32)}.mp3`, encoding: 'hex', prefix: 'b'.repeat(40), suffix: 'c'.repeat(40) }), /too long/);
  assert.equal(outputName({ name: 'Привет 🌎.mp4' }), 'Привет 🌎.webm');
});
test('settings reject unknown formats, encodings and unsafe account values', () => {
  assert.throws(() => validateOptions({ format: 'mkv' }));
  assert.throws(() => validateOptions({ encoding: 'raw' }));
  assert.throws(() => validateOptions({ userhash: 'hello\r\nworld' }));
  assert.equal(validateOptions({ catbox: 'true' }).catbox, false);
});
test('Catbox response validation rejects credentials, other hosts, redirects and query strings', () => {
  for (const value of ['http://files.catbox.moe/a.mp3', 'https://catbox.moe/a.mp3', 'https://files.catbox.moe.evil/a.mp3', `${url}?a=b`, 'https://x@files.catbox.moe/a.mp3', 'OK']) assert.throws(() => validateCatboxUrl(value));
});
test('splits preserve the complete duration, without gaps or oversize parts', () => {
  for (const total of [0.1, 119, 119.01, 120, 120.01, 300, 3600.125]) {
    const parts = segments(total); let position = 0;
    for (const part of parts) {
      assert.ok(Math.abs(part.start - position) < 1e-6);
      assert.ok(part.duration > 0 && part.duration <= 119);
      position += part.duration;
    }
    assert.ok(Math.abs(position - total) < 1e-6);
  }
  assert.throws(() => segments(130, 'reject'), /too long/);
  assert.equal(segments(119.8, 'reject').length, 1);
});
test('quality profile respects low source frame rates and conservative dimensions', () => {
  for (const bitrate of [10_000, 200_000, 500_000, 1_000_000, 50_000_000]) {
    assert.ok(encodingProfile(bitrate, 12).fps <= 12);
    assert.ok(encodingProfile(bitrate, 60).fps <= 30);
    assert.ok(encodingProfile(bitrate).side <= 1280);
  }
});
test('cancel terminates a running child process', async () => {
  const controller = new AbortController();
  const job = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(job, /Cancelled/);
});
test('ZIP has standard headers, UTF-8 paths, content and directory offsets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-zip-test-'));
  try {
    const input = path.join(dir, 'input.txt'); await fs.writeFile(input, 'hello world');
    const output = path.join(dir, 'out.zip');
    await writeZip([{ path: input, name: 'Привет/input.txt' }], output);
    const data = await fs.readFile(output);
    assert.equal(data.readUInt32LE(), 0x04034b50);
    const end = data.length - 22; assert.equal(data.readUInt32LE(end), 0x06054b50);
    const central = data.readUInt32LE(end + 16); assert.equal(data.readUInt32LE(central), 0x02014b50);
    assert.equal(data.readUInt32LE(central + 16), 0x0d4a1185);
    assert.equal(data.readUInt32LE(central + 20), 11);
    assert.ok(data.includes(Buffer.from('Привет/input.txt'))); assert.ok(data.includes(Buffer.from('hello world')));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('local API requires session token, rejects other origins and never serves arbitrary paths', async () => {
  const app = await createApp();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Frame-Token': app.token } })).status, 200);
    assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Frame-Token': app.token, Origin: 'https://example.com' } })).status, 403);
    // fetch intentionally forbids overriding Host; use a raw HTTP request here.
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/state`, { headers: { 'X-Frame-Token': app.token, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    const response = await fetch(`${base}/api/convert`, { method: 'POST', headers: { 'X-Frame-Token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['unknown'] }) });
    assert.equal(response.status, 400);
  } finally { await app.close(); }
});
