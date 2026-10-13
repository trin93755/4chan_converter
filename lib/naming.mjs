import path from 'node:path';

export const ENCODINGS = ['base64url', 'base64', 'utf8', 'percent', 'hex'];
const invalid = /[<>:"/\\|?*\x00-\x1f\x7f]/u;
const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function validateAffix(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 40 || invalid.test(text)) {
    throw new Error('Prefixes and suffixes may use up to 40 UTF-8 bytes, without / \\ : * ? " < > | or control characters.');
  }
  return text.normalize('NFC');
}

export function validateCatboxUrl(url) {
  if (!/^https:\/\/files\.catbox\.moe\/[a-zA-Z0-9]+\.mp3$/.test(url)) {
    throw new Error('Catbox did not return a valid direct MP3 link.');
  }
  return url;
}

export function encodeLink(url, encoding) {
  validateCatboxUrl(url);
  const bytes = Buffer.from(url, 'utf8');
  switch (encoding) {
    case 'base64url': return bytes.toString('base64url');
    // Slash is not a filename character. %2F can be reversed before Base64 decoding.
    case 'base64': return bytes.toString('base64').replaceAll('/', '%2F');
    // A literal URL cannot be a cross-platform filename. Keep readable text,
    // escaping the two forbidden URL characters reversibly.
    case 'utf8': return url.replaceAll(':', '%3A').replaceAll('/', '%2F');
    case 'percent': return encodeURIComponent(url);
    case 'hex': return bytes.toString('hex');
    default: throw new Error('Choose a supported link encoding.');
  }
}

function shortText(text, maxBytes) {
  let result = '';
  for (const ch of text) {
    if (Buffer.byteLength(result + ch) > maxBytes) break;
    result += ch;
  }
  return result;
}

export function sourceStem(name) {
  let stem = path.parse(name.replaceAll('\\', '/').split('/').pop()).name
    .normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, '_').replace(/[. ]+$/u, '');
  if (!stem || reserved.test(stem)) stem = `video_${stem}`;
  return shortText(stem, 65);
}

export function outputName({ name = 'video.mp4', url = '', format = 'webm', encoding = 'base64url', prefix = '', suffix = '', includeSource = false, part = 0, total = 1, randomName = '' }) {
  if (!['webm', 'mp4'].includes(format)) throw new Error('Invalid output format.');
  const stem = sourceStem(name);
  const body = url ? `${includeSource ? `${stem}_` : ''}${encodeLink(url, encoding)}` : (randomName || stem);
  const partText = total > 1 ? `_part-${String(part + 1).padStart(2, '0')}` : '';
  const result = `${validateAffix(prefix)}${body}${partText}${validateAffix(suffix)}.${format}`;
  if (Buffer.byteLength(result) > 230) throw new Error('The filename is too long. Shorten the prefix or suffix, or turn off the source name.');
  if (reserved.test(result) || invalid.test(result)) throw new Error('This filename is not portable. Change the prefix or suffix.');
  return result;
}

export function validateOptions(raw = {}) {
  const options = {
    format: raw.format ?? 'webm',
    catbox: raw.catbox === true,
    encoding: raw.encoding ?? 'base64url',
    prefix: raw.prefix ?? '', suffix: raw.suffix ?? '',
    includeSource: raw.includeSource === true,
    naming: raw.naming ?? 'source',
    longVideo: raw.longVideo ?? 'split',
    userhash: typeof raw.userhash === 'string' ? raw.userhash.trim() : '',
  };
  if (!['webm', 'mp4'].includes(options.format) || !ENCODINGS.includes(options.encoding)
      || !['source', 'random'].includes(options.naming) || !['split', 'reject'].includes(options.longVideo)) {
    throw new Error('Invalid conversion settings.');
  }
  if (options.userhash && !/^[a-zA-Z0-9]{1,100}$/.test(options.userhash)) throw new Error('The Catbox userhash should contain letters and numbers only.');
  validateAffix(options.prefix); validateAffix(options.suffix);
  outputName({ ...options, url: options.catbox ? 'https://files.catbox.moe/abcdef.mp3' : '', name: 'video.mp4' });
  return options;
}
