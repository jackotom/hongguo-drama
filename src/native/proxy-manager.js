function createProxyManager({
  config,
  getSessions,
  log = () => {},
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let activeAuth = null;
  let version = 0;
  let desired = null;
  const sessionProxyConfigs = new WeakMap();

  function matches(authInfo) {
    if (!authInfo?.isProxy || !activeAuth) return false;
    const host = String(authInfo.host || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === activeAuth.host && Number(authInfo.port) === activeAuth.port;
  }

  async function applyToSession(resolved, sessions = getSessions(), expectedVersion = version) {
    let auth = null;
    let proxy = { mode: resolved.mode === 'direct' ? 'direct' : 'system' };
    if (resolved.mode === 'custom' && resolved.url) {
      const built = config.ruleForSession(resolved);
      if (!built) throw new Error('代理地址无效');
      auth = built.auth;
      proxy = { mode: 'fixed_servers', proxyRules: built.rule };
    }
    const key = JSON.stringify([proxy, auth]);
    await Promise.all(sessions.filter(Boolean).map(async currentSession => {
      if (sessionProxyConfigs.get(currentSession) !== key) {
        await currentSession.setProxy(proxy);
        await currentSession.clearAuthCache?.();
        await currentSession.closeAllConnections?.();
      }
      if (expectedVersion !== version) {
        sessionProxyConfigs.delete(currentSession);
        await applyToSession(desired, [currentSession], version);
        throw new Error('代理设置已被更新');
      }
      sessionProxyConfigs.set(currentSession, key);
    }));
    if (expectedVersion === version) activeAuth = auth;
  }

  async function apply(settings) {
    const resolved = config.resolve(settings);
    const currentVersion = ++version;
    desired = resolved;
    try { await applyToSession(resolved, getSessions(), currentVersion); }
    catch { throw new Error('设置网络代理失败，请重试。'); }
    if (currentVersion !== version) throw new Error('代理设置已被更新');
    config.applyToEnv(resolved);
    log(`[Proxy] mode=${resolved.mode}`);
    return resolved;
  }

  function withTimeout(settings, timeoutMs) {
    let timer;
    return Promise.race([
      apply(settings),
      new Promise((_, reject) => { timer = schedule(() => reject(new Error('代理启动超时')), timeoutMs); }),
    ]).finally(() => cancel(timer));
  }

  async function startup(settings) {
    try {
      config.validateDraft(settings);
      await withTimeout(settings, 15000);
      return { fallback: false, reason: '', fallbackError: '' };
    } catch (error) {
      let fallbackError = '';
      try { await withTimeout({ ...settings, proxy_enabled: false, proxy_mode: 'direct' }, 5000); }
      catch (fallback) { fallbackError = fallback.message; }
      return { fallback: true, reason: error.message, fallbackError };
    }
  }

  return {
    sessionProxyConfigs,
    matches,
    applyToSession,
    apply,
    withTimeout,
    startup,
    get activeAuth() { return activeAuth; },
    get desired() { return desired; },
  };
}

module.exports = { createProxyManager };
