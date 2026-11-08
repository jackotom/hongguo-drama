import { Buffer } from 'buffer/';
let sequence = 0;
const pending = new Map();
globalThis.__nativeProgress = (id, received, total) => {
  const task = pending.get(id);
  if (!task || !Number.isFinite(received) || !Number.isFinite(total) || received < 0 || total < 0) return;
  try { task.progress?.({ received, total }); } catch { /* A progress observer must not interrupt the transfer. */ }
};
globalThis.__nativeResponse = (id, raw) => {
  const task = pending.get(id);
  if (!task) return;
  task.finish();
  try {
    const response = JSON.parse(raw);
    if (response.error) task.reject(Object.assign(new Error(response.error), { code: response.code || 'ERR_NETWORK' }));
    else task.resolve(response);
  } catch (error) { task.reject(error); }
};
export default function request(options) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, signal = options.signal;
    const cancel = () => {
      finish(); Native.cancel?.(id);
      reject(Object.assign(new Error('已取消'), { code: 'ERR_CANCELED' }));
    };
    const finish = () => { pending.delete(id); signal?.removeEventListener('abort', cancel); };
    if (signal?.aborted) { cancel(); return; }
    pending.set(id, { resolve, reject, finish, cancel, progress: typeof options.onProgress === 'function' ? options.onProgress : undefined });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      Native.request(id, JSON.stringify({
        url: options.url, method: options.method || 'GET', headers: options.headers || {},
        timeout: Math.max(500, Math.min(30000, options.timeout || 15000)),
        body: options.data == null ? null : Buffer.from(options.data).toString('base64'),
        media: options.media === true, encrypted: options.encrypted === true,
      }));
    } catch (error) { finish(); reject(error); }
  });
}
request.get = (url, options = {}) => request({ ...options, url });
export function cancelAll() { for (const task of [...pending.values()]) task.cancel(); }
