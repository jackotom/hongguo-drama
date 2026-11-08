import { Buffer } from 'buffer/';
export const gzipSync = data => Buffer.from(Native.gzip(Buffer.from(data).toString('base64')), 'base64');
