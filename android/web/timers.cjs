// Shared source pacing needs cancellable delays in the WebView.
exports.setTimeout = (milliseconds, value, { signal } = {}) => new Promise((resolve, reject) => {
  let timer;
  const abort = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    reject(Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError', code: 'ABORT_ERR', cause: signal.reason,
    }));
  };
  if (signal?.aborted) { abort(); return; }
  timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve(value);
  }, milliseconds);
  signal?.addEventListener('abort', abort, { once: true });
});
