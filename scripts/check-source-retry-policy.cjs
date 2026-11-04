const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const native = fs.readFileSync(path.join(__dirname, '../src/native/hongguo.js'), 'utf8');
const context = vm.createContext({ normalizeDownloadQuality: value => value || 'auto' });
vm.runInContext(main.slice(main.indexOf('function sourceFailureIsTransient('), main.indexOf('function armSourceRetry(')), context);
vm.runInContext(native.slice(native.indexOf('function sourceFailure('), native.indexOf('function unavailableSources(')), context);
const task = { hongguoInfo: { vid: '11' }, downloadQuality: 'auto' };
const unavailable = code => ({ code: 'SOURCE_UNAVAILABLE', sources: [
  { source: 'web', code: 'TIMEOUT' }, { source: 'app', code }, { source: 'api', code: 'TIMEOUT' },
] });
for (const code of ['DEVICE_REGISTRATION_FAILED', 'HTTP_403', 'HTTP_429', 'BUSINESS_REJECTED', 'SECURITY_BLOCKED']) {
  const error = unavailable(code);
  assert.equal(context.sourceFailureIsTransient(error), false, `${code}: an unrelated timeout must not retry App rejection`);
  assert.equal(context.isDeferrableSourceError(task, error), false, `${code}: must not schedule automatic download retries`);
}
for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'HTTP_503', 'MISSING_MODEL']) {
  assert.equal(context.sourceFailureIsTransient(unavailable(code)), true, `${code}: other transient routes can still recover`);
}
assert.equal(context.isDeferrableSourceError(task, { code: 'ECONNRESET' }), true);
for (const registrationFailure of ['INVALID_RESPONSE', 'EMPTY_RESPONSE', 'BUSINESS_REJECTED']) {
  const reason = context.sourceFailure('app', { code: 'DEVICE_REGISTRATION_FAILED', registrationFailure });
  assert.match(reason.message, /本机冷却/);
  assert.match(reason.message, /上游.*恢复.*无法确认/);
  assert.doesNotMatch(reason.message, /请检查网络/);
}
console.log('PASS source retry policy: App rejection stops mixed-route automatic retries; upstream recovery is not promised');
