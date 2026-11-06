// Connect only to the isolated application launched by an acceptance check.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(port) {
  let target;
  for (let i = 0; i < 200 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
      .find(item => item.type === 'page' && item.url.includes('dist-react')); } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Isolated application did not expose its renderer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error || message.result?.exceptionDetails) request.reject(new Error(message.error?.message
      || message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
    else request.resolve(message.result?.result?.value);
  });
  return { close: () => socket.close(), evaluate(expression, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Application evaluation timed out')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } };
}
module.exports = { connect, sleep };
