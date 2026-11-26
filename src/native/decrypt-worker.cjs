const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

function transferableArrayBuffer(value) {
  if (!value || !ArrayBuffer.isView(value)) return null;
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && !(value.buffer instanceof SharedArrayBuffer)) {
    return value.buffer;
  }
  return null;
}

// Media parsing and sample decryption must not block Electron's cancellation IPC.
function decryptInWorker(payload, { signal, cancelToken } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || cancelToken?.reason) return reject(new Error('已取消'));
    const transferList = [];
    const inputBuf = transferableArrayBuffer(payload?.buffer);
    if (inputBuf) transferList.push(inputBuf);
    const worker = new Worker(__filename, { workerData: payload, ...(transferList.length ? { transferList } : {}) });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      cancelToken?.unsubscribe?.(cancel);
      // Wait for the writer to stop before the caller removes temporary files.
      await worker.terminate();
      if (error) reject(error);
      else resolve(result?.buffer ? Buffer.from(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength) : undefined);
    };
    const cancel = () => { void finish(new Error('已取消')); };
    signal?.addEventListener('abort', cancel, { once: true });
    cancelToken?.subscribe?.(cancel);
    worker.once('message', result => void finish(result.error ? new Error(result.error) : null, result));
    worker.once('error', error => void finish(error));
    worker.once('exit', code => { if (!settled) void finish(new Error(`视频处理意外中断（${code}）`)); });
    if (signal?.aborted || cancelToken?.reason) cancel();
  });
}

if (!isMainThread) {
  try {
    const native = require('./hongguo');
    const key = Buffer.from(workerData.key);
    if (workerData.srcPath) {
      native.decryptMp4File(workerData.srcPath, workerData.dstPath, key);
      parentPort.postMessage({ done: true });
    } else {
      const input = Buffer.isBuffer(workerData.buffer)
        ? workerData.buffer
        : Buffer.from(workerData.buffer.buffer, workerData.buffer.byteOffset, workerData.buffer.byteLength);
      const result = native.decryptMp4Buffer(input, key);
      const outBuf = transferableArrayBuffer(result);
      if (outBuf) parentPort.postMessage({ buffer: result }, [outBuf]);
      else parentPort.postMessage({ buffer: result });
    }
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
}

module.exports = { decryptInWorker };
