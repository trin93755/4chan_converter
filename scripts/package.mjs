import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../lib/zip.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const files = [];
async function add(relative) {
  const absolute = path.join(root, relative);
  if ((await fs.stat(absolute)).isDirectory()) {
    for (const name of await fs.readdir(absolute)) await add(path.join(relative, name));
  } else files.push({ path: absolute, name: `4chan-gem-converter/${relative.replaceAll('\\', '/')}` });
}
for (const name of ['server.mjs', 'package.json', 'README.md', 'Start 4chan gem converter.bat', 'Start 4chan gem converter.command', 'start.sh', 'lib', 'public', 'tests', 'scripts', 'packaging', 'docs', '.github', '.gitignore', '.gitattributes']) await add(name);
await fs.mkdir(path.join(root, 'releases'), { recursive: true });
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const destination = path.join(root, 'releases', `4chan-gem-converter-${version}.zip`);
await writeZip(files, destination);
console.log(destination);
