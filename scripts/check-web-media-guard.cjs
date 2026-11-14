// Offline boundary checks; only the explicit local test proxy opens a socket.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const nativePath = path.resolve(__dirname, '../src/native/hongguo.js');
const req = createRequire(nativePath);
const guardPath = path.join(path.dirname(nativePath), 'web-media-guard.js');
const privateUrls = ['http://127.0.0.1/a', 'http://2130706433/a', 'http://0x7f000001/a',
  'http://10.0.0.1/a', 'http://172.31.0.1/a', 'http://192.168.1.1/a', 'http://169.254.169.254/a',
  'http://100.64.0.1/a', 'http://[::1]/a', 'http://[::]/a', 'http://[fd00::1]/a',
  'http://[fe80::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://localhost./a', 'http://nas.local/a',
  'http://printer/a', 'file:///etc/passwd', 'https://user:pass@media.example/a'];
const publicUrls = ['https://fc-cdn.example/a', 'https://fd-cdn.example/a', 'https://fe80-cdn.example/a',
  'https://hongguoduanju.com/video/public/11/360p.mp4', 'https://8.8.8.8/a', 'https://[2606:4700::1111]/a'];

function mainFixture(root, calls, marked) {
  const mainPath = path.resolve(__dirname, '../main.js'), mainRequire = createRequire(mainPath);
  const app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => root, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const axios = Object.assign(async config => { calls.push(config); return { status: 200, headers: {}, data: 'ok' }; }, { isCancel: () => false });
  const native = { UA: 'app', WEB_UA: 'browser', WEB_REFERER: 'https://hongguoduanju.com/',
    fetchPlayUrlSingle: async () => ({ url: 'https://media.example/safe', source: 'app' }), markWebMediaFailure: info => marked.push(info.vid) };
  const context = vm.createContext({ require: n => n === 'electron' ? { app, ipcMain: { handle() {} }, protocol: { registerSchemesAsPrivileged() {} } }
    : n === 'axios' ? axios : n === './src/native/hongguo' ? native : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root }) } : mainRequire(n),
    __dirname: path.dirname(mainPath), process, Buffer, URL, Request, Response, Headers, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context);
  return context;
}

function provider(mediaUrl) {
  const data = { loaderData: { 'player_(series_id)/(vid)/page': { isSuccess: true, vid: '11', series_id: '1',
    seriesDetail: { series_id: '1' }, publicVideoSeo: { available: true, itemId: '11', seriesId: '1' } } } };
  const html = `<script>window._ROUTER_DATA=${JSON.stringify(data)}</script><script type="application/ld+json">${JSON.stringify({
    '@type': 'VideoObject', url: 'https://hongguoduanju.com/player/1/11', contentUrl: mediaUrl })}</script>`;
  const context = { module: { exports: {} }, Buffer, URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    process: { env: {} }, console: { warn() {} },
    require: n => n === 'axios' ? { get: async () => ({ data: html }) } : req(n) };
  vm.runInNewContext(fs.readFileSync(nativePath, 'utf8'), context);
  return context.module.exports;
}
function guardWithDns(addresses, answer = '8.8.8.8', resolver) {
  const context = { module: { exports: {} }, URL, setTimeout, clearTimeout,
    require: n => n === 'node:dns' ? { lookup: (_host, _options, callback) => callback(null, addresses) }
      : n === 'node:https' ? { ...req(n), get: resolver || ((url, options, callback) => {
        assert.ok(['https://1.1.1.1/dns-query', 'https://223.5.5.5/resolve'].includes(url.split('?')[0]));
        const request = new EventEmitter();
        request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
        process.nextTick(() => {
          const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
          callback(response);
          response.emit('data', JSON.stringify({ Status: 0, Answer: [{ type: 1, data: answer, TTL: 60 }] }));
          response.emit('end'); request.emit('close');
        });
        return request;
      }) } : req(n) };
  vm.runInNewContext(fs.readFileSync(guardPath, 'utf8'), context);
  return context.module.exports;
}

// Run the real guarded lookup, then route an accepted public address to a local fixture server.
function loopbackAfterGuard(options) {
  options.httpAgent.createConnection = (connection, callback) => {
    connection.lookup(connection.host, { all: true }, error => {
      if (error) return callback(error);
      const socket = http.Agent.prototype.createConnection.call(options.httpAgent,
        { ...connection, host: '127.0.0.1', hostname: undefined, lookup: undefined });
      callback(null, socket);
    });
  };
  return options;
}
const checks = [
  ['catalog trusted DNS is opt-in, origin-bound and isolated from ordinary sockets', async () => {
    const guard = guardWithDns([{ address: '9.9.9.9', family: 4 }]);
    const lookup = options => new Promise((resolve, reject) => options.lookup('hongguoduanju.com', { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses)));
    const normal = guard.webMediaRequestOptions('https://hongguoduanju.com/rank/hot-drama');
    const trusted = guard.webMediaRequestOptions('https://hongguoduanju.com/rank/hot-drama', { trustedOfficialDns: true });
    assert.equal((await lookup(normal))[0].address, '9.9.9.9');
    assert.equal((await lookup(trusted))[0].address, '8.8.8.8', 'trusted route must bypass even a public system-DNS answer');
    assert.notEqual(trusted.httpsAgent, normal.httpsAgent, 'a warm ordinary socket must not defeat the independent DNS route');
    assert.equal(normal.proxy, undefined, 'existing media requests retain configured proxy behavior');
    assert.equal(trusted.proxy, false, 'explicit trusted catalog route must remain direct');
    for (const url of ['http://hongguoduanju.com/a', 'https://hongguoduanju.com:444/a', 'https://other.example/a']) {
      assert.throws(() => guard.webMediaRequestOptions(url, { trustedOfficialDns: true }), /公网/);
    }
  }],
  ['catalog trusted DNS still rejects private redirect destinations and their DNS answers', async () => {
    const guard = guardWithDns([{ address: '127.0.0.1', family: 4 }]);
    const options = guard.webMediaRequestOptions('https://hongguoduanju.com/rank/hot-drama', { trustedOfficialDns: true });
    assert.throws(() => options.beforeRedirect({}, { headers: { location: 'http://127.0.0.1/private' } },
      { url: 'https://hongguoduanju.com/rank/hot-drama' }), /公网/);
    options.beforeRedirect({}, { headers: { location: 'https://other.example/rank' } },
      { url: 'https://hongguoduanju.com/rank/hot-drama' });
    await assert.rejects(new Promise((resolve, reject) => options.lookup('other.example', { all: true },
      (error, addresses) => error ? reject(error) : resolve(addresses))), /公网/);
  }],
  ['guarded Range requests reuse validated sockets without global agents', async () => {
    const axios = req('axios'), guard = guardWithDns([{ address: '8.8.8.8', family: 4 }]);
    const connections = new Set();
    const server = http.createServer((request, response) => {
      connections.add(request.socket); assert.equal(request.headers.range, 'bytes=0-1');
      response.writeHead(206); response.end('ok');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://media.example:${server.address().port}/a`;
    try {
      for (let i = 0; i < 3; i++) {
        const options = loopbackAfterGuard(guard.webMediaRequestOptions(url));
        assert.notEqual(options.httpAgent, http.globalAgent);
        assert.notEqual(options.httpsAgent, https.globalAgent);
        await axios.get(url, { proxy: false, timeout: 2000, headers: { Range: 'bytes=0-1' }, ...options });
      }
      assert.equal(connections.size, 1, 'three guarded Range requests must reuse one validated socket');
      assert.equal(guard.webMediaRequestOptions(url).httpsAgent, guard.webMediaRequestOptions(url).httpsAgent);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['new connections revalidate DNS after a previously accepted public connection', async () => {
    const axios = req('axios'), records = [{ address: '8.8.8.8', family: 4 }], guard = guardWithDns(records);
    let hits = 0;
    const server = http.createServer((_request, response) => { hits++; response.writeHead(200, { Connection: 'close' }); response.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://media.example:${server.address().port}/a`;
    try {
      await axios.get(url, { proxy: false, timeout: 2000, ...loopbackAfterGuard(guard.webMediaRequestOptions(url)) });
      records[0] = { address: '127.0.0.1', family: 4 };
      await assert.rejects(axios.get(url, { proxy: false, timeout: 2000, ...loopbackAfterGuard(guard.webMediaRequestOptions(url)) }),
        error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
      assert.equal(hits, 1, 'rebound private address must never receive a second request');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['trusted proxy sockets cannot later bypass direct media DNS validation', async () => {
    const axios = req('axios'), guard = guardWithDns([{ address: '127.0.0.1', family: 4 }]);
    let hits = 0;
    const server = http.createServer((_request, response) => { hits++; response.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const url = 'http://media.example/a';
      await axios.get(url, { proxy: { host: 'user-proxy.example', port, protocol: 'http' }, timeout: 2000, ...guard.webMediaRequestOptions(url) });
      const direct = `http://user-proxy.example:${port}/private`;
      await assert.rejects(axios.get(direct, { proxy: false, timeout: 2000, ...guard.webMediaRequestOptions(direct) }),
        error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
      assert.equal(hits, 1, 'a proxy socket is trusted only for requests still using the proxy');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['provider rejects local/private URLs and retains valid CDN hostnames', async () => {
    for (const url of privateUrls) assert.equal(await provider(url).fetchPlayUrlFromWeb('11', '1'), null, url);
    for (const url of publicUrls) assert.equal((await provider(url).fetchPlayUrlFromWeb('11', '1')).url, url);
  }],
  ['URL guard covers mapped IPv6 without confusing CDN names with IP prefixes', () => {
    const guard = req(guardPath);
    for (const url of privateUrls) assert.equal(guard.isPublicMediaUrl(url), false, url);
    for (const url of publicUrls) assert.equal(guard.isPublicMediaUrl(url), true, url);
  }],
  ['socket DNS lookup rejects private, mixed and mapped answers', async () => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '::ffff:192.168.1.1', family: 6 }],
      [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]]) {
      const options = guardWithDns(addresses).webMediaRequestOptions('https://media.example/a');
      await assert.rejects(new Promise((resolve, reject) => options.lookup('media.example', { all: true },
        (error, result) => error ? reject(error) : resolve(result))), /公网/);
    }
  }],
  ['Fake-IP fallback resolves ordinary media through trusted DNS and still rejects mixed private answers', async () => {
    const records = [{ address: '198.18.14.190', family: 4 }];
    const lookup = (guard, host) => new Promise((resolve, reject) => guard.lookup(host, { all: true },
      (error, result) => error ? reject(error) : resolve(result)));
    const guard = guardWithDns(records).webMediaRequestOptions('https://hongguoduanju.com/video/a');
    assert.equal((await lookup(guard, 'hongguoduanju.com'))[0].address, '8.8.8.8');
    await assert.rejects(lookup(guardWithDns(records, '127.0.0.1').webMediaRequestOptions('https://hongguoduanju.com/a'), 'hongguoduanju.com'), /公网/,
      'trusted resolver must not be able to return a private address');
    const cdn = guardWithDns(records).webMediaRequestOptions('https://media.example/a');
    assert.equal((await lookup(cdn, 'media.example'))[0].address, '8.8.8.8');
    const redirected = await Promise.all((await Promise.all([
      lookup(guardWithDns(records).webMediaRequestOptions('https://media.example/a'), 'media.example'),
      lookup(guardWithDns(records).webMediaRequestOptions('https://sub.hongguoduanju.com/a'), 'sub.hongguoduanju.com'),
    ])).map(values => values[0].address));
    assert.deepEqual(redirected, ['8.8.8.8', '8.8.8.8']);
    assert.throws(() => guardWithDns(records).webMediaRequestOptions('https://198.18.14.190/a'), /公网/);
    for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1']) {
      await assert.rejects(lookup(guardWithDns([...records, { address, family: 4 }])
        .webMediaRequestOptions('https://hongguoduanju.com/a'), 'hongguoduanju.com'), /公网/,
      `mixed Fake-IP and ${address} must be rejected`);
    }
    guard.beforeRedirect({}, { headers: { location: 'http://hongguoduanju.com/b' } }, { url: 'https://hongguoduanju.com/a' });
    await assert.rejects(lookup(guard, 'hongguoduanju.com'), /公网/, 'downgraded redirect must not use trusted DNS');
  }],
  ['official secure DNS survives an unavailable or hanging resolver and cancels the loser', async () => {
    for (const hanging of [false, true]) {
      const calls = [], requests = [];
      const guard = guardWithDns([{ address: '198.18.14.190', family: 4 }], undefined, (url, options, callback) => {
        calls.push(url);
        assert.equal(options.rejectUnauthorized, undefined, 'TLS certificate verification must stay enabled');
        assert.equal(options.lookup, undefined, 'fixed resolver IP must not use local DNS');
        const request = new EventEmitter(); requests.push(request);
        request.destroy = error => { request.destroyed = true; if (error) request.emit('error', error); request.emit('close'); };
        process.nextTick(() => {
          if (url.startsWith('https://1.1.1.1/')) {
            if (!hanging) request.destroy(Object.assign(new Error('unavailable'), { code: 'ECONNRESET' }));
            return;
          }
          assert.equal(url, 'https://223.5.5.5/resolve?name=hongguoduanju.com&type=A');
          const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
          callback(response);
          response.emit('data', JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8', TTL: 60 }] }));
          response.emit('end'); request.emit('close');
        });
        return request;
      }).webMediaRequestOptions('https://hongguoduanju.com/a');
      const lookup = () => new Promise((resolve, reject) => guard.lookup('hongguoduanju.com', { all: true },
        (error, value) => error ? reject(error) : resolve(value)));
      const values = await Promise.all([lookup(), lookup()]);
      assert.equal(values[0][0].address, '8.8.8.8');
      assert.equal(values[1][0].address, '8.8.8.8');
      await lookup();
      assert.equal(calls.length, 2, 'parallel consumers and warm cache must share one resolver race');
      assert.equal(requests.every(request => request.destroyed), true);
    }
  }],
  ['secure DNS fails closed on redirect, invalid TLS, private and oversized responses', async () => {
    for (const mode of ['redirect', 'tls', 'private', 'oversized']) {
      const guard = guardWithDns([{ address: '198.18.14.190', family: 4 }], undefined, (_url, options, callback) => {
        assert.notEqual(options.rejectUnauthorized, false);
        const request = new EventEmitter();
        request.destroy = error => { if (error) request.emit('error', error); request.emit('close'); };
        process.nextTick(() => {
          if (mode === 'tls') return request.destroy(Object.assign(new Error('certificate failed'), { code: 'CERT_HAS_EXPIRED' }));
          const response = new EventEmitter(); response.statusCode = mode === 'redirect' ? 302 : 200;
          response.headers = { location: 'https://127.0.0.1/resolve' }; response.setEncoding = () => {};
          callback(response);
          response.emit('data', mode === 'oversized' ? 'x'.repeat(65537) : JSON.stringify({ Status: 0,
            Answer: [{ type: 1, data: mode === 'private' ? '198.18.0.1' : '8.8.8.8', TTL: 60 }] }));
          response.emit('end'); request.emit('close');
        });
        return request;
      }).webMediaRequestOptions('https://hongguoduanju.com/a');
      await assert.rejects(new Promise((resolve, reject) => guard.lookup('hongguoduanju.com', { all: true },
        (error, value) => error ? reject(error) : resolve(value))), error =>
          error.code === (mode === 'tls' ? 'CERT_HAS_EXPIRED' : 'ERR_WEB_MEDIA_ADDRESS'));
    }
  }],
  ['unguarded warm sockets cannot bypass a guarded request', async () => {
    const axios = req('axios'); let hits = 0;
    const server = http.createServer((_request, response) => { hits++; response.end('ok'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://media.example:${server.address().port}/a`;
    try {
      await axios.get(url, { proxy: false, timeout: 2000, lookup: (_h, options, cb) =>
        cb(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4) });
      await assert.rejects(axios.get(url, { proxy: false, timeout: 2000,
        ...guardWithDns([{ address: '127.0.0.1', family: 4 }]).webMediaRequestOptions(url) }),
        error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
      assert.equal(hits, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['public DNS preserves all/single lookup shape and trusts configured proxy resolution', async () => {
    const records = [{ address: '8.8.8.8', family: 4 }];
    const options = guardWithDns(records).webMediaRequestOptions('https://media.example/a');
    options.lookup('media.example', { all: true }, (error, addresses) => { assert.ifError(error); assert.equal(addresses[0].address, '8.8.8.8'); });
    options.lookup('media.example', {}, (error, address, family) => { assert.ifError(error); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    guardWithDns([{ address: '127.0.0.1', family: 4 }]).webMediaRequestOptions('https://media.example/a')
      .lookup('user-proxy.example', {}, (error, address) => { assert.ifError(error); assert.equal(address, '127.0.0.1'); });
  }],
  ['redirect validation uses media Location, not the local proxy address', () => {
    const guard = req(guardPath).webMediaRequestOptions('https://media.example/a');
    const proxyOptions = { hostname: '127.0.0.1' }, request = { url: 'https://media.example/a' };
    for (const url of privateUrls) assert.throws(() => guard.beforeRedirect(proxyOptions, { headers: { location: url } }, request));
    assert.doesNotThrow(() => guard.beforeRedirect(proxyOptions, { headers: { location: '/b' } }, request));
    assert.doesNotThrow(() => guard.beforeRedirect(proxyOptions, { headers: { location: 'https://fc-cdn.example/b' } }, request));
  }],
  ['redirect DNS is guarded at connection time too', async () => {
    const guard = guardWithDns([{ address: '192.168.1.1', family: 4 }]).webMediaRequestOptions('https://media.example/a');
    guard.beforeRedirect({}, { headers: { location: 'https://other.example/b' } }, { url: 'https://media.example/a' });
    await assert.rejects(new Promise((resolve, reject) => guard.lookup('other.example', {},
      (error, result) => error ? reject(error) : resolve(result))), /公网/);
  }],
  ['real Axios direct connection rejects a private DNS answer before opening a socket', async () => {
    const options = guardWithDns([{ address: '127.0.0.1', family: 4 }]).webMediaRequestOptions('http://media.example/a');
    await assert.rejects(req('axios').get('http://media.example/a', { proxy: false, timeout: 2000, ...options }),
      error => error.code === 'ERR_WEB_MEDIA_ADDRESS');
  }],
  ['real Axios proxy follows public redirects but blocks private destinations before a second request', async () => {
    const axios = req('axios'), { webMediaRequestOptions } = req(guardPath);
    const hits = [];
    const server = http.createServer((request, response) => {
      hits.push(request.url);
      if (request.url.endsWith('/bad')) response.writeHead(302, { Location: 'http://127.0.0.1/private' });
      else if (request.url.endsWith('/start')) response.writeHead(302, { Location: 'http://fc-cdn.example/final' });
      else { assert.equal(request.headers.range, 'bytes=0-1'); response.writeHead(206); }
      response.end('ok');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const proxy = { host: '127.0.0.1', port: server.address().port, protocol: 'http' };
    try {
      await assert.rejects(axios.get('http://media.example/bad', { proxy, timeout: 2000, ...webMediaRequestOptions('http://media.example/bad') }), /公网/);
      assert.equal(hits.length, 1);
      const response = await axios.get('http://media.example/start', { proxy, timeout: 2000, headers: { Range: 'bytes=0-1' }, ...webMediaRequestOptions('http://media.example/start') });
      assert.equal(response.status, 206); assert.equal(hits.length, 3);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }],
  ['main blocks an unsafe web transfer then uses existing bounded App recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-guard-')), calls = [], marked = [];
    try {
      const main = mainFixture(root, calls, marked);
      const result = await main.withMediaRecovery('11', '1', { playInfo: { url: 'http://127.0.0.1/private', source: 'web', vid: '11' } }, info => main.requestMedia(info));
      assert.equal(result.status, 200); assert.equal(calls.length, 1); assert.deepEqual(marked, ['11']);
      assert.equal(calls[0].url, 'https://media.example/safe');
      assert.equal(calls[0].headers['User-Agent'], 'app');
      assert.equal(typeof calls[0].lookup, 'function', 'App source also validates public DNS');
      assert.equal(typeof calls[0].beforeRedirect, 'function', 'App source also validates redirects');
      await main.requestMedia({ url: 'https://fc-cdn.example/safe', source: 'web' });
      assert.equal(typeof calls[1].lookup, 'function');
      assert.equal(typeof calls[1].beforeRedirect, 'function');
      assert.equal(calls[1].headers['User-Agent'], 'browser');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }],
];
(async () => {
  let failures = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`${checks.length - failures}/${checks.length} web media guard checks passed`);
  process.exitCode = failures ? 1 : 0;
})();
