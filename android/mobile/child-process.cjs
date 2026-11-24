module.exports = {
  spawn() {
    throw Object.assign(new Error('Android 不启用 SDK 取源'), { code: 'SDK_UNAVAILABLE' });
  },
};
