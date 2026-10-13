import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = `${process.platform}-${process.arch}`;
const names = { 'win32-x64': 'windows-x64', 'darwin-arm64': 'macos-apple-silicon', 'darwin-x64': 'macos-intel', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' };
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gem-portable-'));
let child;
try {
  const archive = path.join(root, 'releases', `4chan-gem-converter-${names[target]}.zip`);
  if (process.platform === 'win32') await run('tar', ['-xf', archive, '-C', temporary]);
  else await run('unzip', ['-q', archive, '-d', temporary]);
  const app = path.join(temporary, '4chan gem converter');
  const node = path.join(app, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  const launcher = path.join(app, 'packaging/launch.mjs');
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'packaging/runtimes.json'), 'utf8'));
  const setup = await run(node, [launcher, '--setup-only'], { timeout: 600_000 });
  console.log(setup.stdout);
  const engine = path.join(app, 'bin', manifest.engineRelease);
  const env = { ...process.env,
    FFMPEG_PATH: path.join(engine, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    FFPROBE_PATH: path.join(engine, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
  };
  const tests = (await fs.readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.mjs') || name === 'media.integration.mjs').map(name => path.join(root, 'tests', name));
  const validation = await run(node, ['--test', ...tests], { env, timeout: 600_000, maxBuffer: 4_000_000 });
  console.log(validation.stdout);
  // Launch exactly the distributed app, including its setup path and bundled runtime.
  child = spawn(node, [launcher, '--no-open'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged launcher did not start.')), 30_000);
    let output = '';
    const collect = chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/);
      if (match) { clearTimeout(timer); resolve(new URL(match[0])); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Launcher exited early: ${output}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const headers = { 'X-Frame-Token': address.hash.slice(1) };
  const config = await (await fetch(new URL('/api/config', address), { headers })).json();
  assert.equal(config.dependencies.ready, true);
  assert.equal(config.version, JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8')).version);
  assert.match(await (await fetch(new URL('/', address))).text(), /4chan gem converter/);
  assert.equal((await fetch(new URL('/api/shutdown', address), { method: 'POST', headers })).status, 200);
  assert.equal(await exit, 0);
  child = null;
  console.log(`Packaged ${target} launcher, runtime, engine, API, conversion suites, and shutdown passed.`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill(); await closed; }
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
