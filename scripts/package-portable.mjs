import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { downloadVerified, hashFile } from '../lib/download.mjs';
import { zipRelease } from './zip-release.mjs';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'packaging/runtimes.json'), 'utf8'));
const target = process.argv[2] || `${process.platform}-${process.arch}`;
if (!manifest.targets[target]) throw new Error(`Unsupported target: ${target}`);
const names = { 'win32-x64': 'windows-x64', 'darwin-arm64': 'macos-apple-silicon', 'darwin-x64': 'macos-intel', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' };
const stage = path.join(root, '.frame-work', 'packages', target, '4chan gem converter');
const cache = path.join(root, '.frame-work', 'downloads');
await fs.mkdir(stage, { recursive: true });
await fs.mkdir(cache, { recursive: true });
const asset = manifest.targets[target].node;
const archive = path.join(cache, path.basename(new URL(asset.url).pathname));
await downloadVerified(asset, archive);
const nodeRoot = `node-${manifest.nodeVersion}-${target.replace('win32', 'win')}`;
const extraction = path.join(cache, target);
await fs.mkdir(extraction, { recursive: true });
const nodeName = target.startsWith('win32') ? 'node.exe' : 'bin/node';
await run('tar', ['-xf', archive, '-C', extraction, `${nodeRoot}/${nodeName}`, `${nodeRoot}/LICENSE`]);
await fs.mkdir(path.join(stage, 'bin'), { recursive: true });
await fs.mkdir(path.join(stage, 'licenses'), { recursive: true });
const nodeDestination = path.join(stage, 'bin', target.startsWith('win32') ? 'node.exe' : 'node');
await fs.copyFile(path.join(extraction, nodeRoot, nodeName), nodeDestination);
await fs.chmod(nodeDestination, 0o755);
await fs.copyFile(path.join(extraction, nodeRoot, 'LICENSE'), path.join(stage, 'licenses/Node.txt'));
for (const name of ['server.mjs', 'package.json', 'lib', 'public', 'packaging']) await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true });
const launcher = target.startsWith('win32') ? 'Start.bat' : target.startsWith('darwin') ? 'Start.command' : 'Start.sh';
const start = target.startsWith('win32')
  ? '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0bin\\node.exe" "%~dp0packaging\\launch.mjs" %*\r\nif errorlevel 1 pause\r\n'
  : '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\n./bin/node ./packaging/launch.mjs "$@"\nresult=$?\nif [ "$result" -ne 0 ]; then printf "\\nPress Enter to close."; read -r answer; fi\nexit "$result"\n';
await fs.writeFile(path.join(stage, launcher), start, { mode: 0o755 });
await fs.chmod(path.join(stage, launcher), 0o755);
const instruction = target.startsWith('linux') ? 'Open Start.sh and choose Run as a program.\nIf your file manager only opens it as text, open a terminal in this folder\nand run: sh Start.sh' : `Double-click ${launcher}.`;
await fs.writeFile(path.join(stage, 'START HERE.txt'), `4chan gem converter\n\n1. Extract the whole ZIP into a folder you can write to.\n2. ${instruction}\n3. Add videos, choose WebM or MP4, and Convert.\n\nFirst launch downloads the video engine (internet required).\nLater conversions work offline; only optional Catbox audio needs internet.\nKeep the launcher window open. Quit in the app when finished.\nExports go to outputs inside this folder. Originals are kept.\n\nHelp and updates: https://github.com/trin93755/4chan_converter\n\nUnsigned portable package. Your operating system may ask you to approve\nopening a downloaded program; no certificate installation is needed.\n`);
await fs.writeFile(path.join(stage, 'licenses/ABOUT.txt'), 'Node.js is bundled with its license. FFmpeg and FFprobe are downloaded directly\nfrom the ffmpeg-static upstream release on first launch; their build information\nand license are saved beside them under bin. Download URLs and SHA-256 hashes\nare recorded in packaging/runtimes.json.\n\nRin artwork is unofficial fan art inspired by TYPE-MOON Fate/stay night.\nArtwork provenance: public/art/provenance.json\n');
// Explicit allowlist: never add cached engines, user media, preferences, or outputs.
const files = [];
async function add(relative) {
  const absolute = path.join(stage, relative);
  if ((await fs.stat(absolute)).isDirectory()) { for (const name of (await fs.readdir(absolute)).sort()) await add(path.join(relative, name)); }
  else files.push({ path: absolute, name: `4chan gem converter/${relative.replaceAll('\\', '/')}`, executable: relative === launcher || absolute === nodeDestination });
}
for (const name of ['server.mjs', 'package.json', 'lib', 'public', 'packaging', 'licenses', 'START HERE.txt', launcher, path.relative(stage, nodeDestination)]) await add(name);
const destination = path.join(root, 'releases', `4chan-gem-converter-${names[target]}.zip`);
await fs.mkdir(path.dirname(destination), { recursive: true });
await zipRelease(files, destination);
await fs.writeFile(`${destination}.sha256`, `${await hashFile(destination)}  ${path.basename(destination)}\n`);
console.log(destination);
