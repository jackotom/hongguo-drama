const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

function localMediaEnv(env = process.env) {
  const copy = { ...env };
  for (const key of PROXY_ENV_KEYS) delete copy[key];
  return copy;
}

module.exports = { localMediaEnv };
