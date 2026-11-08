import { Buffer } from 'buffer/';
const originalToString = Buffer.prototype.toString;
Buffer.prototype.toString = function(encoding, ...args) {
  return encoding === 'base64url'
    ? originalToString.call(this, 'base64', ...args).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : originalToString.call(this, encoding, ...args);
};
export { Buffer };
