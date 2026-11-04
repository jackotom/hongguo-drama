// Cookie reads can finish after the sandbox window closes. Check lifetime before verification.
function createWebLoginObserver({ readCookies, complete, cancel, onSignedIn, onError = () => {} }) {
  let closed = false, running = false, dirty = false;
  async function inspect() {
    if (closed) return;
    if (running) { dirty = true; return; }
    running = true;
    try {
      const cookies = await readCookies();
      if (closed || !cookies.some(item => ['sessionid', 'sessionid_ss'].includes(item.name) && item.value)) return;
      const result = await complete(cookies.map(item => `${item.name}=${item.value}`).join('; '));
      if (!closed && result.success === false) throw new Error(result.error || '账号验证失败，请重试');
      if (!closed && result.status === 'signed-in') { closed = true; onSignedIn(); }
    } catch (error) { if (!closed) onError(error); }
    finally {
      running = false;
      if (dirty && !closed) { dirty = false; void inspect(); }
    }
  }
  return { inspect, close() { if (closed) return; closed = true; cancel(); } };
}
module.exports = { createWebLoginObserver };
