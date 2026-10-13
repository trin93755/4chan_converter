import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

// Streaming, uncompressed ZIP. No external package and no whole-batch RAM copy.
export async function writeZip(files, destination) {
  const file = await fs.open(destination, 'w');
  const central = [];
  let offset = 0;
  const write = async buffer => {
    let at = 0;
    while (at < buffer.length) at += (await file.write(buffer, at)).bytesWritten;
    offset += buffer.length;
  };
  try {
    if (files.length > 65535) throw new Error('Too many files for one archive.');
    for (const item of files) {
      const name = Buffer.from(item.name || path.basename(item.path));
      const size = (await fs.stat(item.path)).size;
      if (size > 0xffffffff || offset + size > 0xffffff00) throw new Error('This batch is too large for one ZIP. Open the output folder instead.');
      const start = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6);
      header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let crc = 0xffffffff;
      for await (const chunk of createReadStream(item.path)) {
        for (const b of chunk) crc = table[(crc ^ b) & 255] ^ (crc >>> 8);
        await write(chunk);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); await write(descriptor);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x808, 8); entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(size, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(start, 42);
      central.push(entry, name);
    }
    const centralStart = offset;
    for (const buffer of central) await write(buffer);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - centralStart, 12); end.writeUInt32LE(centralStart, 16); await write(end);
  } finally { await file.close(); }
}
