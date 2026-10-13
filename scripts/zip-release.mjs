import { createReadStream, promises as fs } from 'node:fs';
import { createDeflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });

// Compressed distribution ZIP with Unix permissions. Video export ZIPs stay separate.
export async function zipRelease(files, destination) {
  const file = await fs.open(destination, 'w');
  let offset = 0;
  const central = [];
  const write = async data => { let at = 0; while (at < data.length) at += (await file.write(data, at)).bytesWritten; offset += data.length; };
  try {
    if (files.length > 65535) throw new Error('Too many package files.');
    for (const item of files) {
      const name = Buffer.from(item.name);
      const size = (await fs.stat(item.path)).size;
      const start = offset;
      if (size > 0xffffffff || start > 0xffffffff) throw new Error('Package exceeds ZIP32 limits.');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6); header.writeUInt16LE(8, 8);
      header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
      await write(header); await write(name);
      let crc = 0xffffffff;
      const checksum = new Transform({ transform(chunk, encoding, callback) { for (const byte of chunk) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); callback(null, chunk); } });
      const contentStart = offset;
      await pipeline(createReadStream(item.path), checksum, createDeflateRaw({ level: 6 }), async source => { for await (const chunk of source) await write(chunk); });
      crc = (crc ^ 0xffffffff) >>> 0;
      const compressed = offset - contentStart;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x808, 8); entry.writeUInt16LE(8, 10);
      entry.writeUInt16LE(33, 14); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(name.length, 28);
      entry.writeUInt32LE((((item.executable ? 0o100755 : 0o100644) << 16) >>> 0), 38); entry.writeUInt32LE(start, 42);
      central.push(entry, name);
    }
    const start = offset;
    for (const buffer of central) await write(buffer);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
  } finally { await file.close(); }
}
