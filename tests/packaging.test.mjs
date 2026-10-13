import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { downloadVerified, unpackVerified } from '../lib/download.mjs';
import { zipRelease } from '../scripts/zip-release.mjs';
import { pathToFileURL } from 'node:url';
import { isMain } from '../lib/main.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
test('entry detection follows directory aliases and Windows path casing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gem-entry-'));
  try {
    const real = path.join(dir, 'MixedCase');
    const alias = path.join(dir, 'alias');
    await fs.mkdir(real);
    await fs.writeFile(path.join(real, 'entry.mjs'), '');
    await fs.writeFile(path.join(real, 'other.mjs'), '');
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const url = pathToFileURL(path.join(real, 'entry.mjs'));
    assert.equal(await isMain(url, path.join(alias, 'entry.mjs')), true);
    assert.equal(await isMain(url, path.join(real, 'other.mjs')), false);
    assert.equal(await isMain(url, path.join(dir, 'missing.mjs')), false);
    if (process.platform === 'win32') assert.equal(await isMain(url, path.join(alias, 'entry.mjs').toLowerCase()), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('engine downloads reject changed bytes, preserve existing files, and reuse verified files offline', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gem-download-'));
  try {
    const destination = path.join(dir, 'engine');
    const bytes = Buffer.from('verified engine');
    const asset = { url: 'https://example.invalid/engine', sha256: digest(bytes) };
    await fs.writeFile(destination, 'existing');
    await assert.rejects(downloadVerified(asset, destination, { fetcher: async () => new Response('changed bytes') }), /verification failed/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(dir), ['engine']);
    await downloadVerified(asset, destination, { fetcher: async () => new Response(bytes) });
    await downloadVerified(asset, destination, { fetcher: async () => { throw new Error('Must work offline'); } });
    assert.equal(await fs.readFile(destination, 'utf8'), bytes.toString());
    await assert.rejects(downloadVerified({ ...asset, url: 'http://example.invalid/engine' }, destination), /Invalid/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('engine extraction verifies decompressed bytes before publishing an executable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gem-unpack-'));
  try {
    const bytes = Buffer.from('engine bytes');
    const archive = path.join(dir, 'engine.gz');
    const destination = path.join(dir, 'engine');
    await fs.writeFile(archive, gzipSync(bytes));
    await assert.rejects(unpackVerified(archive, destination, '0'.repeat(64)), /verification failed/);
    assert.deepEqual(await fs.readdir(dir), ['engine.gz']);
    await unpackVerified(archive, destination, digest(bytes));
    assert.deepEqual(await fs.readFile(destination), bytes);
    if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o755);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('distribution ZIP keeps executable permissions, UTF-8 names, and compressed data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gem-package-'));
  try {
    const source = path.join(dir, 'launch');
    const bytes = Buffer.from('#!/bin/sh\necho hello\n'.repeat(100));
    await fs.writeFile(source, bytes);
    const destination = path.join(dir, 'archive.zip');
    await zipRelease([{ path: source, name: 'gem/Start.command', executable: true }], destination);
    const zip = await fs.readFile(destination);
    const end = zip.length - 22;
    const central = zip.readUInt32LE(end + 16);
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt16LE(central + 4) >> 8, 3);
    assert.equal(zip.readUInt32LE(central + 38) >>> 16, 0o100755);
    assert.equal(zip.readUInt16LE(central + 10), 8);
    assert.ok(zip.readUInt16LE(central + 8) & 0x800);
    const compressedSize = zip.readUInt32LE(central + 20);
    const dataStart = 30 + zip.readUInt16LE(26);
    assert.deepEqual(inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)), bytes);
    assert.ok(compressedSize < bytes.length / 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
