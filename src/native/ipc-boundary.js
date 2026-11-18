const { safeErrorText, sanitizeIpcValue } = require('./error-text');

function createIpcBoundary({
  rawIpcMain,
  isTrustedSender,
  getMainWindow,
  getQuitCleanup,
  getInstaller,
  blockedChannels,
  onPendingChange = () => {},
}) {
  return {
    handle(channel, handler) {
      rawIpcMain.handle(channel, async (event, ...args) => {
        if (!isTrustedSender(event, getMainWindow())) throw new Error('窗口请求无效');
        if (getQuitCleanup()) return { success: false, error: '正在退出，请等待清理完成。' };
        if (getInstaller()?.getState().status === 'installing' && blockedChannels.has(channel)) {
          return { success: false, error: '正在安装更新，请等待应用重新启动。' };
        }
        const blocksUpdate = blockedChannels.has(channel);
        if (blocksUpdate) onPendingChange(1);
        try {
          return sanitizeIpcValue(await handler(event, ...args));
        } catch (error) {
          if (error && typeof error.message === 'string') error.message = safeErrorText(error.message);
          throw error;
        } finally {
          if (blocksUpdate) onPendingChange(-1);
        }
      });
    },
  };
}

module.exports = { createIpcBoundary };
