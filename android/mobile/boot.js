// Safe diagnostic codes only: never print requests, signed URLs, cookies or keys.
window.addEventListener('error', event => {
  console.error(`HG:runtime:${String(event.error?.name || 'Error').replace(/[^A-Za-z]/g,'')}:${Number(event.lineno) || 0}`);
  const root = document.getElementById('root');
  if (root && !root.childElementCount) {
    const text = document.createElement('p'); text.textContent = '应用加载失败。请保留应用数据，重新打开或反馈问题。';
    root.appendChild(text);
  }
});
window.addEventListener('unhandledrejection', event => console.error(`HG:promise:${String(event.reason?.name || 'Error').replace(/[^A-Za-z]/g,'')}`));
