import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// File identity survives symlinks, macOS /var aliases, and Windows path casing.
export async function isMain(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    const [invoked, module] = await Promise.all([stat(entry, { bigint: true }), stat(fileURLToPath(moduleUrl), { bigint: true })]);
    return invoked.dev === module.dev && invoked.ino === module.ino;
  } catch { return false; }
}
