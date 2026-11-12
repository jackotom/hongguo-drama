const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// An optional dependency directory keeps release checks away from shared node_modules.
const dependencyRequire = createRequire(path.resolve(process.argv[2] || path.join(__dirname, '..'), 'package.json'));
const redirects = dependencyRequire('follow-redirects');
const axios = dependencyRequire('axios');
const headers = {
  Authorization: 'Bearer fixture-only',
  'Proxy-Authorization': 'Basic fixture-only',
  Cookie: 'session=fixture-only',
  'X-API-Key': 'fixture-only',
  'X-Harmless': 'preserved',
};
const sensitiveHeaders = vm.runInNewContext("['X-API-Key']");
const lookup = (_hostname, options, callback) => options.all
  ? callback(null, [{ address: '127.0.0.1', family: 4 }])
  : callback(null, '127.0.0.1', 4);

function get(url) {
  return new Promise((resolve, reject) => {
    const request = redirects.http.get(url, { headers, sensitiveHeaders, lookup, maxRedirects: 3 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('redirect fixture timed out')));
  });
}

function checkCrossOrigin(received) {
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
    assert.equal(received[name], undefined, `${name} must not follow a cross-origin redirect`);
  }
  assert.equal(received['x-harmless'], 'preserved');
}

async function main() {
  assert.equal(Array.isArray(sensitiveHeaders), true);
  assert.equal(sensitiveHeaders instanceof Array, false);
  const server = http.createServer((request, response) => {
    const port = server.address().port;
    if (request.url === '/cross') {
      response.writeHead(302, { Location: `http://target.example:${port}/target` });
    } else if (request.url === '/same') {
      response.writeHead(302, { Location: '/target' });
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.headers));
      return;
    }
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const origin = `http://source.example:${server.address().port}`;
    checkCrossOrigin(await get(`${origin}/cross`));
    const sameOrigin = await get(`${origin}/same`);
    for (const [name, value] of Object.entries(headers)) {
      assert.equal(sameOrigin[name.toLowerCase()], value, 'same-origin redirects preserve request headers');
    }
    const response = await axios.get(`${origin}/cross`, {
      headers, sensitiveHeaders, lookup, proxy: false, timeout: 2000, maxRedirects: 3,
    });
    checkCrossOrigin(response.data);
    assert.equal(dependencyRequire('axios/package.json').version, '1.20.0');
    assert.equal(dependencyRequire('follow-redirects/package.json').version, '1.16.3');
    console.log('Redirect security: cross-realm credentials stripped, same-origin headers preserved, Axios 1.20.0 integration passed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
