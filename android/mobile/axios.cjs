const transport = require('../web/transport.js').default;
async function axios(options) {
  if (typeof options === 'string') options = { url: options };
  let url = new URL(options.url), response;
  const origin = url.origin;
  for (let i = 0; i < 4; i++) {
    response = await transport({ ...options, url: url.href });
    if ([301,302,303,307,308].includes(response.status) && response.headers?.location && options.maxRedirects !== 0) {
      url = new URL(response.headers.location, url);
      if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('来源跳转地址不受支持');
      continue;
    }
    if (!(options.validateStatus ? options.validateStatus(response.status) : response.status >= 200 && response.status < 300)) {
      throw Object.assign(new Error(`请求失败（HTTP ${response.status}）`), { response, code: `HTTP_${response.status}` });
    }
    return response;
  }
  throw new Error('来源跳转次数过多');
}
axios.get = (url, options = {}) => axios({ ...options, url });
axios.post = (url, data, options = {}) => axios({ ...options, url, data, method:'POST' });
axios.isCancel = error => error?.code === 'ERR_CANCELED';
module.exports = axios;
