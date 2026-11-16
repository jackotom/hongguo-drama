import { Buffer } from 'buffer/';
export const gzipSync = data => Buffer.from(Native.gzip(Buffer.from(data).toString('base64')), 'base64');
export const gunzipSync = (data, { maxOutputLength = 2 * 1024 * 1024 } = {}) => {
  const limit = 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1 || maxOutputLength > limit) throw new RangeError('Invalid gzip output limit');
  const input = Buffer.from(data);
  if (input.length > limit) throw new RangeError('Compressed gzip data exceeds limit');
  const output = Buffer.from(Native.gunzip(input.toString('base64'), maxOutputLength), 'base64');
  if (output.length > maxOutputLength) throw new RangeError('Gzip output exceeds limit');
  return output;
};
