const { isIP, BlockList } = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

function guardedAgent(Agent) {
  const agent = new Agent({ keepAlive: true });
  const getName = agent.getName;
  const proxyRoute = Symbol('proxyRoute');
  // Explicit proxies may resolve privately; never lend their sockets to direct media requests.
  agent.addRequest = (request, options) => Agent.prototype.addRequest.call(agent, request,
    { ...options, [proxyRoute]: /^https?:\/\//i.test(request.path) });
  agent.getName = options => `${getName.call(agent, options)}:${options[proxyRoute] ? 'proxy' : 'direct'}`;
  return agent;
}
const httpAgent = guardedAgent(http.Agent);
const httpsAgent = guardedAgent(https.Agent);
// A trusted-DNS request must not reuse a socket opened through ordinary DNS.
const trustedOfficialHttpsAgent = guardedAgent(https.Agent);

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['2001:db8::', 32], ['2001::', 32], ['2002::', 16]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
globalV6.addSubnet('::ffff:0:0', 96, 'ipv6');
const fakeV4 = new BlockList();
fakeV4.addSubnet('198.18.0.0', 15, 'ipv4');

function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
const isFakeAddress = address => isIP(address) === 4 && fakeV4.check(address, 'ipv4');

function isPublicMediaUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (isIP(host)) return isPublicAddress(host);
    return host.includes('.') && !/(^|\.)(localhost|local|internal|lan|home)$/.test(host);
  } catch (_) { return false; }
}

function blockedAddress() {
  return Object.assign(new Error('官网片源及其跳转、解析结果必须指向公网'), { code: 'ERR_WEB_MEDIA_ADDRESS', mediaRetryable: true });
}

// The local VPN's Fake-IP route can return a different CDN result. Fall back to fixed
// HTTPS resolvers only when every system answer is Fake-IP; never connect to Fake-IP.
const publicDnsCache = new Map(), publicDnsPending = new Map();
function resolvePublicAddresses(hostname) {
  const key = hostname.toLowerCase();
  const cached = publicDnsCache.get(key);
  if (cached?.expires > Date.now()) return Promise.resolve(cached.addresses);
  if (publicDnsPending.has(key)) return publicDnsPending.get(key);
  const requests = [];
  // Race trusted resolvers so a blocked regional route cannot delay the usable one.
  const pending = Promise.any(['https://1.1.1.1/dns-query', 'https://223.5.5.5/resolve'].map(endpoint => new Promise((resolve, reject) => {
    const request = https.get(`${endpoint}?name=${encodeURIComponent(hostname)}&type=A`, {
      agent: new https.Agent({ keepAlive: false }), headers: { Accept: 'application/dns-json' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', reject);
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 65536) request.destroy(blockedAddress());
      });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const rows = (data.Answer || []).filter(item => item.type === 1);
          if (response.statusCode !== 200 || data.Status !== 0 || !rows.length ||
              rows.some(item => isIP(item.data) !== 4 || !isPublicAddress(item.data))) throw blockedAddress();
          const addresses = rows.map(item => ({ address: item.data, family: 4 }));
          const ttl = Math.max(0, Math.min(60, ...rows.map(item => Number(item.TTL) || 0)));
          resolve({ addresses, expires: Date.now() + ttl * 1000 });
        } catch (_) { reject(blockedAddress()); }
      });
    });
    requests.push(request);
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('官网安全 DNS 解析超时'), { code: 'ETIMEDOUT' })), 4000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  }))).then(result => {
    publicDnsCache.set(key, result);
    return result.addresses;
  }).catch(error => {
    throw error.errors?.find(item => item.code === 'ERR_WEB_MEDIA_ADDRESS') || error.errors?.[0] || error;
  }).finally(() => {
    requests.forEach(request => request.destroy());
    publicDnsPending.delete(key);
  });
  publicDnsPending.set(key, pending);
  return pending;
}

function webMediaRequestOptions(value, { trustedOfficialDns = false } = {}) {
  if (!isPublicMediaUrl(value)) throw blockedAddress();
  const initial = new URL(value);
  if (trustedOfficialDns && initial.origin !== 'https://hongguoduanju.com') throw blockedAddress();
  const hosts = new Map([[initial.hostname.toLowerCase(), initial]]);
  return {
    maxRedirects: 5,
    // Reuse only this guard's sockets; new connections still run the request's checked lookup.
    httpAgent,
    httpsAgent: trustedOfficialDns ? trustedOfficialHttpsAgent : httpsAgent,
    ...(trustedOfficialDns ? { proxy: false } : {}),
    lookup(hostname, options, callback) {
      const settings = typeof options === 'number' ? { family: options } : options || {};
      const finish = addresses => {
        if (settings.all) callback(null, addresses);
        else if (addresses.length) callback(null, addresses[0].address, addresses[0].family);
        else callback(new Error('片源域名未解析到地址'));
      };
      const target = hosts.get(hostname.toLowerCase());
      const official = target?.origin === 'https://hongguoduanju.com';
      if (official && trustedOfficialDns) {
        if (settings.family === 6) return callback(blockedAddress());
        resolvePublicAddresses(hostname).then(finish, callback);
        return;
      }
      dns.lookup(hostname, { ...settings, all: true }, (error, addresses) => {
        if (error) return callback(error);
        // Validate actual socket resolution; a separate preflight permits rebinding.
        if (target && (!addresses.length || addresses.some(item => !isPublicAddress(item.address)))) {
          const fakeOnly = addresses.length > 0 && addresses.every(item => isFakeAddress(item.address));
          if (fakeOnly && target.protocol === 'https:' && settings.family !== 6) {
            resolvePublicAddresses(hostname).then(finish, callback);
            return;
          }
          return callback(blockedAddress());
        }
        // User-selected proxies may be local; their remote DNS remains a trust boundary.
        finish(addresses);
      });
    },
    beforeRedirect(_options, response, request) {
      const target = new URL(response.headers.location, request.url);
      if (!isPublicMediaUrl(target.href)) throw blockedAddress();
      hosts.set(target.hostname.toLowerCase(), target);
    },
  };
}

function warmOfficialDns() { return resolvePublicAddresses('hongguoduanju.com').catch(() => {}); }

module.exports = { isPublicMediaUrl, webMediaRequestOptions, warmOfficialDns };
