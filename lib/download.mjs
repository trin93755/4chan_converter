import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function matchesFile(filename, expected) {
  try { return await hashFile(filename) === expected; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Download into a sibling temporary file; only verified bytes become executable.
export async function downloadVerified(asset, destination, { fetcher = fetch } = {}) {
  if (!/^https:\/\//.test(asset.url) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid download manifest.');
  if (await matchesFile(destination, asset.sha256)) return;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomBytes(6).toString('hex')}.partial`;
  try {
    const response = await fetcher(asset.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). Check your connection and open the launcher again.`);
    const hash = createHash('sha256');
    const check = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), check, createWriteStream(temporary, { flags: 'wx' }));
    if (hash.digest('hex') !== asset.sha256) throw new Error('Download verification failed. Open the launcher again to retry.');
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function unpackVerified(gzip, destination, expected) {
  if (await matchesFile(destination, expected)) return;
  const temporary = `${destination}.${randomBytes(6).toString('hex')}.partial`;
  try {
    await pipeline(createReadStream(gzip), createGunzip(), createWriteStream(temporary, { flags: 'wx' }));
    if (!await matchesFile(temporary, expected)) throw new Error('Video engine verification failed.');
    await fs.chmod(temporary, 0o755);
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
}
