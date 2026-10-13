import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { PROFILE, EXTENSIONS, TOOL, dependencies, probe, run, convert } from './lib/converter.mjs';
import { validateOptions, outputName } from './lib/naming.mjs';
import { writeZip } from './lib/zip.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.zip': 'application/zip', '.json': 'application/json' };
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function openExternal(target) {
  const program = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(program, [target], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}

export async function createApp({ outputRoot = path.join(ROOT, 'outputs'), token = randomBytes(32).toString('hex') } = {}) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-session-'));
  const files = new Map();
  const results = new Map();
  let batch = null, batchWork = null, archivePromise = null, closing = false;
  const depsPromise = dependencies();
  const serializeFile = item => ({ id: item.id, name: item.name, size: item.size, state: item.state,
    progress: item.progress || 0, stage: item.stage || '', error: item.error || '', thumbnail: !!item.thumbnail,
    info: item.info ? { duration: item.info.duration, width: item.info.width, height: item.info.height, codec: item.info.codec, fps: item.info.fps, hasAudio: item.info.hasAudio } : null,
    outputs: (item.outputs || []).map(({ path: ignored, audioPath, ...rest }) => ({ ...rest, hasLocalAudio: !!audioPath })) });
  const publicState = () => ({ files: [...files.values()].map(serializeFile), batch: batch ? { active: batch.active, outputDir: batch.outputDir, started: batch.started, error: batch.error || '' } : null });

  async function jsonBody(req) {
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 65_536) throw new Error('Request is too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(data)); };
  async function sendFile(req, res, filename, downloadName) {
    const stat = await fs.stat(filename);
    const headers = { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': stat.size };
    if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    res.writeHead(200, headers);
    await pipeline(createReadStream(filename), res);
  }

  async function manifest() {
    const data = { application: 'Frame 1.1.0', profile: PROFILE, created: batch.started,
      files: batch.ids.map(id => files.get(id)).filter(Boolean).map(item => ({ source: item.name, state: item.state, error: item.error,
        outputs: item.outputs.map(({ path: filePath, audioPath, ...output }) => ({ ...output, file: path.relative(batch.outputDir, filePath), localAudio: audioPath ? path.relative(batch.outputDir, audioPath) : null })) })) };
    const temp = path.join(batch.outputDir, '.conversion-report.tmp');
    await fs.writeFile(temp, JSON.stringify(data, null, 2));
    await fs.rename(temp, path.join(batch.outputDir, 'conversion-report.json'));
  }

  async function workBatch(options) {
    for (const id of batch.ids) {
      const item = files.get(id);
      if (batch.cancelled) { item.state = 'cancelled'; item.stage = 'Cancelled'; continue; }
      item.state = 'processing'; item.controller = new AbortController();
      try {
        await convert({ source: item.path, name: item.name, info: item.info, options, outputDir: batch.outputDir, signal: item.controller.signal,
          onProgress: (progress, stage) => { item.progress = Math.round(progress * 100); item.stage = stage; },
          onOutput: async output => { item.outputs.push(output); results.set(output.id, output); await manifest(); } });
        item.state = 'done'; item.progress = 100; item.stage = 'Verified';
      } catch (error) {
        item.state = item.controller.signal.aborted ? 'cancelled' : 'error'; item.error = error.message; item.stage = item.state === 'cancelled' ? 'Cancelled' : 'Needs attention';
      } finally { item.controller = null; }
      await manifest();
    }
    batch.active = false;
    await manifest();
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: 'Use the local address shown in the launcher.' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) return json(res, 403, { error: 'Cross-origin requests are not allowed.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith('/api/')) {
        const staticFiles = { '/': 'index.html', '/app.js': 'app.js', '/rin.js': 'rin.js', '/style.css': 'style.css', '/rin.css': 'rin.css', '/icon.svg': 'icon.svg',
          '/art/rin-guide.png': 'art/rin-guide.png', '/art/rin-jewel.png': 'art/rin-jewel.png' };
        if (req.method !== 'GET' || !staticFiles[url.pathname]) return json(res, 404, { error: 'Not found.' });
        return await sendFile(req, res, path.join(ROOT, 'public', staticFiles[url.pathname]));
      }
      if (!equal(req.headers['x-frame-token'], token)) return json(res, 401, { error: 'Open Frame using the link shown in the launcher.' });
      if (closing) return json(res, 503, { error: 'Frame is shutting down.' });
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { profile: PROFILE, dependencies: await depsPromise, outputRoot, extensions: [...EXTENSIONS], version: '1.1.0' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, publicState());
      if (req.method === 'POST' && url.pathname === '/api/files') {
        const deps = await depsPromise;
        if (!deps.ready) throw new Error(deps.error);
        const name = (url.searchParams.get('name') || 'video').replaceAll('\\', '/').split('/').pop();
        const ext = path.extname(name).toLowerCase();
        if (!EXTENSIONS.has(ext)) throw new Error('Choose a supported video file: MP4, WebM, MOV, MKV, AVI, or another listed format.');
        const expected = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 20 * 1024 ** 3) throw new Error('Choose a non-empty video smaller than 20 GiB.');
        const id = randomBytes(12).toString('hex');
        const filename = path.join(work, id + ext);
        let received = 0;
        try {
          await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
            received += chunk.length;
            callback(received > expected ? new Error('Upload exceeded the declared size.') : null, chunk);
          } }), createWriteStream(filename, { flags: 'wx' }));
          if (received !== expected) throw new Error('The file was not fully imported. Try adding it again.');
          const info = await probe(filename);
          const item = { id, name, size: received, path: filename, info, state: 'ready', outputs: [] };
          files.set(id, item);
          const thumbnail = path.join(work, id + '.jpg');
          // Thumbnail failure never prevents conversion.
          try {
            await run(TOOL.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(Math.min(1, info.duration / 3)), '-i', filename, '-map', `0:${info.videoIndex}`, '-frames:v', '1', '-vf', 'scale=160:100:force_original_aspect_ratio=decrease', thumbnail], { timeout: 15_000 });
            item.thumbnail = thumbnail;
          } catch {}
          return json(res, 201, serializeFile(item));
        } catch (error) { await fs.rm(filename, { force: true }); throw error; }
      }
      if (req.method === 'POST' && url.pathname === '/api/filename') {
        const data = await jsonBody(req);
        const options = validateOptions(data);
        return json(res, 200, { filename: outputName({ ...options, name: data.name || 'my-video.mp4', url: options.catbox ? 'https://files.catbox.moe/abcdef.mp3' : '', randomName: options.naming === 'random' ? '83e10b256dfa704c' : '' }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/convert') {
        if (batch?.active) throw new Error('A batch is already running.');
        const data = await jsonBody(req);
        const options = validateOptions(data.options);
        if (!(await depsPromise).ready) throw new Error((await depsPromise).error);
        const ids = [...new Set(Array.isArray(data.ids) ? data.ids : [])];
        if (!ids.length || ids.some(id => !files.has(id) || !['ready', 'error', 'cancelled'].includes(files.get(id).state))) throw new Error('Add files to the queue before converting.');
        for (const id of ids) {
          const item = files.get(id);
          outputName({ ...options, name: item.name, url: options.catbox && item.info.hasAudio ? 'https://files.catbox.moe/abcdef.mp3' : '' });
        }
        if (data.outputRoot) {
          if (typeof data.outputRoot !== 'string' || !path.isAbsolute(data.outputRoot)) throw new Error('Enter an absolute output folder path.');
          outputRoot = path.resolve(data.outputRoot);
        }
        const outputDir = path.join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(2).toString('hex')}`);
        await fs.mkdir(outputDir, { recursive: true });
        // Record a batch before processing. Existing output files are never overwritten.
        batch = { ids, active: true, cancelled: false, outputDir, started: new Date().toISOString() };
        for (const id of ids) { const item = files.get(id); item.state = 'queued'; item.error = ''; item.progress = 0; item.stage = 'Waiting'; }
        await manifest();
        batchWork = workBatch(options).catch(async error => {
          batch.active = false; batch.error = error.message;
          for (const id of ids) { const item = files.get(id); if (['queued', 'processing'].includes(item.state)) { item.state = 'error'; item.error = error.message; } }
        });
        return json(res, 202, publicState());
      }
      if (req.method === 'POST' && url.pathname === '/api/cancel') {
        if (batch?.active) { batch.cancelled = true; for (const item of files.values()) item.controller?.abort(); }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && ['/api/remove', '/api/clear'].includes(url.pathname)) {
        const data = await jsonBody(req);
        if (batch?.active) throw new Error('Wait for the batch to finish or cancel it first.');
        const ids = url.pathname === '/api/clear' ? [...files.keys()] : [data.id];
        for (const id of ids) {
          const item = files.get(id); if (!item) continue;
          await fs.rm(item.path, { force: true });
          if (item.thumbnail) await fs.rm(item.thumbnail, { force: true });
          for (const output of item.outputs) results.delete(output.id);
          files.delete(id);
        }
        return json(res, 200, publicState());
      }
      if (req.method === 'POST' && url.pathname === '/api/reveal') {
        const target = batch?.outputDir || outputRoot;
        await fs.mkdir(target, { recursive: true }); openExternal(target);
        return json(res, 200, { path: target });
      }
      if (req.method === 'GET' && url.pathname === '/api/thumbnail') {
        const item = files.get(url.searchParams.get('id'));
        if (!item?.thumbnail) return json(res, 404, { error: 'No thumbnail.' });
        return await sendFile(req, res, item.thumbnail);
      }
      if (req.method === 'GET' && url.pathname === '/api/download') {
        const output = results.get(url.searchParams.get('id'));
        if (!output) return json(res, 404, { error: 'This output is no longer in the queue. Open the output folder to find it.' });
        const target = url.searchParams.get('audio') === '1' ? output.audioPath : output.path;
        if (!target) return json(res, 404, { error: 'No extracted audio is available.' });
        return await sendFile(req, res, target, path.basename(target));
      }
      if (req.method === 'GET' && url.pathname === '/api/archive') {
        if (batch?.active || !results.size) throw new Error('Wait for conversion to finish before downloading the batch.');
        if (!archivePromise) {
          const outputFiles = [...results.values()].map(item => ({ path: item.path, name: `${item.id}/${item.name}` }));
          for (const output of results.values()) if (output.audioPath) outputFiles.push({ path: output.audioPath, name: `${output.id}/${path.basename(output.audioPath)}` });
          const report = { application: 'Frame 1.1.0', profile: PROFILE, created: new Date().toISOString(),
            files: [...files.values()].filter(item => item.outputs.length).map(item => ({ source: item.name,
              outputs: item.outputs.map(({ path: ignored, audioPath, ...output }) => ({ ...output,
                file: `${output.id}/${output.name}`, localAudio: audioPath ? `${output.id}/${path.basename(audioPath)}` : null })) })) };
          const reportPath = path.join(work, 'archive-report.json');
          await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
          outputFiles.push({ path: reportPath, name: 'conversion-report.json' });
          archivePromise = writeZip(outputFiles, path.join(work, 'frame-exports.zip')).then(() => path.join(work, 'frame-exports.zip'));
        }
        try { return await sendFile(req, res, await archivePromise, 'frame-exports.zip'); }
        finally { archivePromise = null; }
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        json(res, 200, { ok: true }); setTimeout(() => close(), 100); return;
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, 400, { error: error.message });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 0; server.headersTimeout = 30_000;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (batch) batch.cancelled = true;
    for (const item of files.values()) item.controller?.abort();
    await batchWork;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(work, { recursive: true, force: true });
  };
  return { server, token, close, files, results, work };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Frame needs Node.js 22 or newer.');
  const app = await createApp();
  const portArg = process.argv.indexOf('--port');
  const requestedPort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;
  app.server.listen(requestedPort, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${app.server.address().port}/#${app.token}`;
    console.log(`\n  FRAME · Local video converter\n\n  ${url}\n\n  Keep this window open while converting. Ctrl+C to quit.\n`);
    if (!process.argv.includes('--no-open')) openExternal(url);
  });
  app.server.on('error', error => { console.error(error.message); app.close(); process.exitCode = 1; });
  process.on('SIGINT', () => app.close()); process.on('SIGTERM', () => app.close());
}
