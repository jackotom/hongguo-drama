/**
 * IPC handlers for network proxy status inspection and live connectivity testing.
 */
function registerProxyIpc({
  ipcMain,
  axios,
  getCurrentSettings,
  applyEditableSettings,
  resolveProxyConfig,
  publicProxyUrl,
  publicProxyError,
  proxyConfig,
  PROXY_TEST_URL,
}) {
  ipcMain.handle('get-proxy-status', async () => {
    const settings = getCurrentSettings();
    const resolved = resolveProxyConfig(settings);
    return {
      enabled: settings.proxy_enabled === true,
      mode: resolved.mode,
      url: publicProxyUrl(resolved.url),
      effective: resolved.mode !== 'direct' && !!resolved.url,
    };
  });

  // 用当前表单值实测代理是否连通（未保存也能测）
  ipcMain.handle('test-proxy', async (_event, draft) => {
    const settings = applyEditableSettings(getCurrentSettings(), draft);
    const resolved = resolveProxyConfig(settings);
    if (resolved.mode === 'custom' && !resolved.url) {
      return { success: false, error: '请填写完整的代理地址与端口' };
    }

    // 只测 API/下载路由。system 使用启动快照，避免未保存的草稿读到当前手动/直连环境。
    let proxyOption;
    try { proxyOption = proxyConfig.requestOption(resolved); }
    catch { return { success: false, error: '代理地址格式无效' }; }

    const started = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 12000);
    deadline.unref?.();
    try {
      const res = await axios.get(PROXY_TEST_URL, {
        timeout: 12000,
        maxContentLength: 2 * 1024 * 1024,
        maxRedirects: 5,
        signal: controller.signal,
        proxy: proxyOption,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        validateStatus: () => true,
      });
      const ms = Date.now() - started;
      if (res.status >= 200 && res.status < 400) {
        return {
          success: true,
          elapsed: ms,
          mode: resolved.mode,
          via: publicProxyUrl(resolved.url) || '(直连)',
          message: `红果官网连接正常（HTTP ${res.status}，耗时 ${ms}ms）`,
        };
      }
      return { success: false, error: `请求返回 HTTP ${res.status}（耗时 ${ms}ms）` };
    } catch (error) {
      const ms = Date.now() - started;
      const code = (error && error.code) || '';
      let hint = publicProxyError(error.message, settings, resolved);
      if (['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
        hint = `测试站点证书校验失败，连接已拒绝；请检查系统时间、证书链或代理的 HTTPS 配置（${code}）`;
      } else if (code === 'ECONNREFUSED') {
        hint = '代理端口拒绝连接，请确认代理软件已启动、端口填写正确';
      } else if (controller.signal.aborted || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
        hint = '连接超时，请检查代理地址/端口或代理是否可用';
      } else if (code === 'ENOTFOUND') {
        hint = '无法解析代理地址，请检查主机名';
      } else if (/407/.test(hint)) {
        hint = '代理需要认证，请填写用户名与密码';
      }
      return { success: false, error: `${hint}（耗时 ${ms}ms）`, code };
    } finally {
      clearTimeout(deadline);
    }
  });
}

module.exports = { registerProxyIpc };
