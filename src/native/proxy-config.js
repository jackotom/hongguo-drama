const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const DEFAULT_TEST_URL = 'https://hongguoduanju.com';

function createProxyConfig({ env = process.env, testUrl = DEFAULT_TEST_URL } = {}) {
  const originalEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, env[key]]));

  function snapshotUrl(targetUrl = testUrl) {
    let target;
    try { target = new URL(targetUrl); } catch { return null; }
    if (!target.host) return null;
    const protocol = target.protocol.split(':', 1)[0];
    const hostname = target.host.replace(/:\d*$/, '');
    const port = parseInt(target.port) || { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 }[protocol] || 0;
    const read = key => originalEnv[key.toLowerCase()] || originalEnv[key.toUpperCase()] || '';
    const bypass = read('no_proxy').toLowerCase();
    if (bypass === '*') return null;
    if (bypass && bypass.split(/[,\s]/).some(entry => {
      if (!entry) return false;
      const match = entry.match(/^(.+):(\d+)$/);
      const host = match ? match[1] : entry;
      const bypassPort = match ? parseInt(match[2]) : 0;
      if (bypassPort && bypassPort !== port) return false;
      if (!/^[.*]/.test(host)) return hostname === host;
      return hostname.endsWith(host.startsWith('*') ? host.slice(1) : host);
    })) return null;
    const proxy = read(`${protocol}_proxy`) || read('all_proxy');
    return proxy ? (proxy.includes('://') ? proxy : `${protocol}://${proxy}`) : null;
  }

  function normalizeSettings(settings) {
    const copy = { ...settings };
    const host = String(copy.proxy_host || '').trim();
    if (!host.includes('@')) return copy;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
      if (url.username || url.password) {
        copy.proxy_username = decodeURIComponent(url.username);
        copy.proxy_password = decodeURIComponent(url.password);
        copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
      }
    } catch {
      copy.proxy_host = host.replace(/^((?:[a-z][a-z0-9+.-]*:\/\/)?)[^/]*@/i, '$1');
    }
    return copy;
  }

  function resolve(settings) {
    const source = settings || {};
    if (source.proxy_enabled !== true) return { mode: 'direct', url: null };
    const mode = source.proxy_mode || 'system';
    if (mode === 'direct') return { mode: 'direct', url: null };
    if (mode === 'custom') {
      const host = String(source.proxy_host || '').trim();
      const port = String(source.proxy_port || '').trim();
      if (!host) return { mode: 'custom', url: null };
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`);
        if (!port && !/:\d+\/?$/.test(host)) return { mode: 'custom', url: null };
        if (port) {
          if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { mode: 'custom', url: null };
          url.port = port;
        }
      url.pathname = '/';
      url.search = '';
      url.hash = '';
        if (String(source.proxy_username || '').trim()) {
          url.username = encodeURIComponent(String(source.proxy_username).trim());
          url.password = encodeURIComponent(String(source.proxy_password || ''));
        }
        return { mode: 'custom', url: url.toString().replace(/\/$/, '') };
      } catch {
        return { mode: 'custom', url: null };
      }
    }
    return { mode: 'system', url: snapshotUrl() };
  }

  function publicUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.pathname = '/';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return '(代理地址已隐藏)';
    }
  }

  function publicError(message, settings, resolved) {
    let text = String(message || '代理连接失败').replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[认证已隐藏]@');
    for (const secret of [settings?.proxy_username, settings?.proxy_password, resolved?.url]) {
      if (!secret) continue;
      for (const value of new Set([String(secret), encodeURIComponent(String(secret))])) text = text.split(value).join('[已隐藏]');
    }
    return text;
  }

  function applyToEnv(resolved, targetEnv = env) {
    for (const key of PROXY_ENV_KEYS) {
      if (resolved.mode === 'system') {
        if (originalEnv[key] !== undefined) targetEnv[key] = originalEnv[key];
        else delete targetEnv[key];
      } else if (resolved.mode === 'custom' && resolved.url && key.toLowerCase() !== 'no_proxy') {
        targetEnv[key] = resolved.url;
      } else {
        delete targetEnv[key];
      }
    }
  }

  function ruleForSession(resolved) {
    let url;
    try { url = new URL(resolved.url); } catch { return null; }
    const protocol = (url.protocol || 'http:').replace(/:$/, '').toLowerCase();
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const hostname = host.includes(':') ? `[${host}]` : host;
    if (!hostname) return null;
    const port = url.port;
    return {
      rule: port ? `${protocol}://${hostname}:${port}` : `${protocol}://${hostname}`,
      auth: url.username ? {
        host,
        port: port ? Number(port) : (protocol === 'https' ? 443 : protocol.startsWith('socks') ? 1080 : 80),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password || ''),
      } : null,
    };
  }

  function validateDraft(settings) {
    const source = settings || {};
    if (source.proxy_enabled !== true) return;
    const mode = source.proxy_mode || 'system';
    if (!['system', 'custom', 'direct'].includes(mode)) throw new Error('不支持的代理模式');
    if (mode !== 'custom') return;
    const resolved = resolve(source);
    if (!resolved.url) throw new Error('请填写完整的代理地址与端口');
    let url;
    try { url = new URL(resolved.url); } catch { throw new Error('代理地址格式无效'); }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) throw new Error('仅支持 HTTP、HTTPS、SOCKS4 或 SOCKS5 代理');
    if (!url.hostname) throw new Error('代理地址格式无效');
    if (!ruleForSession(resolved)) throw new Error('代理地址无法用于系统网络设置');
  }

  function requestOption(resolved) {
    if (!resolved?.url) return false;
    const url = new URL(resolved.url);
    const option = {
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    };
    if (url.username) option.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    return option;
  }

  return {
    testUrl,
    snapshotUrl,
    normalizeSettings,
    resolve,
    publicUrl,
    publicError,
    applyToEnv,
    ruleForSession,
    validateDraft,
    requestOption,
  };
}

module.exports = { createProxyConfig, PROXY_ENV_KEYS };
