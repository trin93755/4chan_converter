import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { downloadVerified, matchesFile, unpackVerified } from '../lib/download.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function prepareEngine() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packaging', 'runtimes.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  const assets = manifest.targets[target]?.engine;
  if (!assets) throw new Error('This computer needs a different download. Choose the matching package on the download page.');
  const directory = path.join(root, 'bin', manifest.engineRelease);
  await fs.mkdir(directory, { recursive: true });
  const paths = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const assetName = `${name}-${target}`;
    const executable = path.join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (!await matchesFile(executable, assets[assetName].sha256)) {
      console.log(`Setting up the video engine (${name === 'ffmpeg' ? '1' : '2'}/2)…`);
      const archive = path.join(directory, `${name}.gz`);
      await downloadVerified(assets[`${assetName}.gz`], archive);
      await unpackVerified(archive, executable, assets[assetName].sha256);
      await fs.rm(archive, { force: true });
    }
    paths[name] = executable;
  }
  for (const extension of ['LICENSE', 'README']) {
    const name = `${target}.${extension}`;
    await downloadVerified(assets[name], path.join(directory, `FFmpeg-${extension}.txt`));
  }
  return paths;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log('\n4chan gem converter\n');
    const engine = await prepareEngine();
    if (process.argv.includes('--setup-only')) console.log('Video engine ready.');
    else {
      const child = spawn(process.execPath, [path.join(root, 'server.mjs'), ...process.argv.slice(2)], {
        cwd: root, stdio: 'inherit', windowsHide: true,
        env: { ...process.env, FFMPEG_PATH: engine.ffmpeg, FFPROBE_PATH: engine.ffprobe },
      });
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    }
  } catch (error) {
    console.error(`\nCould not start: ${error.message}\nCheck your internet connection and try again. No videos have been changed.`);
    process.exitCode = 1;
  }
}
