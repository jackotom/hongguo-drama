import { Buffer } from 'buffer/';

export const randomBytes = n => Buffer.from(Native.random(n), 'base64');
export function randomUUID() {
  const b = randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const s = b.toString('hex');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function createHash(algorithm) {
  const chunks = [];
  return {
    update(data) { chunks.push(Buffer.from(data)); return this; },
    digest(encoding) {
      const result = Buffer.from(Native.digest(algorithm, Buffer.concat(chunks).toString('base64')), 'base64');
      return encoding ? result.toString(encoding) : result;
    },
  };
}
function cipher(decrypt, algorithm, key, iv) {
  const chunks = []; let padding = true;
  return {
    setAutoPadding(value) { padding = value; return this; },
    update(data) { chunks.push(Buffer.from(data)); return Buffer.alloc(0); },
    final() {
      return Buffer.from(Native.crypt(decrypt, algorithm, Buffer.from(key).toString('base64'), iv ? Buffer.from(iv).toString('base64') : '', padding, Buffer.concat(chunks).toString('base64')), 'base64');
    },
  };
}
export const createCipheriv = (algorithm, key, iv) => cipher(false, algorithm, key, iv);
export const createDecipheriv = (algorithm, key, iv) => cipher(true, algorithm, key, iv);
