import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const folders = new Set(['public', 'docs', 'scripts', 'packaging', 'lib', 'tests', '.github']);
const extensions = new Set(['.md', '.mjs', '.js', '.html', '.css', '.svg', '.json', '.yml', '.yaml', '.sh', '.command', '.bat', '.ps1']);
const forbidden = new RegExp(`${String.fromCodePoint(0x2014)}|&(?:mdash|#0*8212|#x0*2014);|\\\\u(?:2014|\\{2014\\})`, 'gi');
const failures = [];

async function scan(directory, top = false) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && (!top || folders.has(entry.name))) await scan(filename);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      const lines = (await fs.readFile(filename, 'utf8')).split(/\r?\n/);
      lines.forEach((line, index) => {
        forbidden.lastIndex = 0;
        if (forbidden.test(line)) failures.push(`${path.relative(root, filename)}:${index + 1}`);
      });
    }
  }
}

await scan(root, true);
if (failures.length) {
  console.error(`Em dashes are not allowed. Rephrase these lines:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log('Copy check passed.');
