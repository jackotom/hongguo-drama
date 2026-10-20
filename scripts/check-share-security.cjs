const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const axios = require('axios');
const { resolveSeriesId } = require('../src/native/hongguo');

async function main() {
  const original = axios.get;
  const calls = [];
  axios.get = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers: {}, data: '{"series_id":"123"}', config: { url } };
  };
  try {
    for (const input of ['data:' + '/'.repeat(4096), 'file:///etc/hosts', 'ftp://example.com/a',
      'javascript:alert(1)', '//example.com/a', 'https://user:secret@example.com/',
      'x'.repeat(8193), 'https://example.com/' + 'x'.repeat(4096), '1'.repeat(31), {}]) {
      calls.length = 0;
      await assert.rejects(resolveSeriesId(input));
      assert.equal(calls.length, 0, 'invalid input must never reach axios');
    }
    assert.equal(await resolveSeriesId(' 1234567890 '), '1234567890');
    calls.length = 0;
    assert.equal(await resolveSeriesId('推荐好剧，点击 https://example.com/share/abc 观看全集'), '123');
    assert.equal(calls[0].url, 'https://example.com/share/abc');
    const options = calls[0].options;
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.responseType, 'text');
    assert.ok(options.maxContentLength > 0 && options.maxContentLength <= 2 * 1024 * 1024);
    assert.ok(options.signal instanceof AbortSignal);

    for (const location of ['data:text/plain,123', 'file:///tmp/test', 'https://user:secret@example.com/',
      'https://example.com/' + 'x'.repeat(4096)]) {
      calls.length = 0;
      axios.get = async url => { calls.push(url); return { status: 302, headers: { location }, data: '' }; };
      await assert.rejects(resolveSeriesId('https://example.com/short'));
      assert.equal(calls.length, 1, 'invalid redirect must not be requested');
    }
    calls.length = 0;
    axios.get = async url => {
      calls.push(url);
      return url.endsWith('/short') ? { status: 302, headers: { location: '/player/456' }, data: '' }
        : { status: 200, headers: {}, data: '{"series_id":"456"}' };
    };
    assert.equal(await resolveSeriesId('https://example.com/short'), '456');
    assert.equal(calls[1], 'https://example.com/player/456');
    calls.length = 0;
    axios.get = async url => { calls.push(url); return { status: 302, headers: { location: '/loop' }, data: '' }; };
    await assert.rejects(resolveSeriesId('https://example.com/loop'));
    assert.ok(calls.length <= 6, 'redirect chain must be bounded');
    axios.get = async () => ({ status: 200, headers: {}, data: '{"series_id":"789"}' });
    assert.equal(await resolveSeriesId('https://example.com/?schemeParams=%ZZ'), '789');
    axios.get = async () => ({ status: 200, headers: {}, data: '{"series_id":"' + '1'.repeat(31) + '"}' });
    await assert.rejects(resolveSeriesId('https://example.com/'));
  } finally { axios.get = original; }

  const body = zlib.gzipSync(Buffer.from('{"series_id":"123","padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}'));
  let reachedServer = false;
  const server = http.createServer((req, res) => {
    reachedServer = true;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  axios.get = (url, options) => original(url, { ...options, proxy: false });
  try {
    await assert.rejects(resolveSeriesId(`http://127.0.0.1:${server.address().port}/`));
    assert.equal(reachedServer, true, 'response limit must be tested against the local server');
  } finally {
    axios.get = original;
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(require('../package.json').version, '1.81.0');
  assert.equal(require('../package.json').dependencies.axios, '1.20.0');
  assert.equal(require('axios/package.json').version, '1.20.0');
  console.log('Share security: invalid input, text, redirects, gzip limit and dependency checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
