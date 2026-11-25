const assert = require('node:assert/strict');
const { test } = require('node:test');
const order = require('./source-order');

test('playback source order drops unknowns, duplicates and appends missing providers', () => {
  assert.deepEqual(order.getSourceOrder(), ['openhongguo', 'sdk', 'app', 'web']);
  assert.deepEqual(order.normalizeSourceOrder(['sdk', 'bad', 'sdk', 'app']), ['sdk', 'app', 'openhongguo', 'web']);
  assert.deepEqual(order.normalizeSourceOrder([]), ['openhongguo', 'sdk', 'app', 'web']);
  assert.deepEqual(order.setSourceOrder(['web', 'sdk']), ['web', 'sdk', 'openhongguo', 'app']);
  assert.deepEqual(order.getSourceOrder(), ['web', 'sdk', 'openhongguo', 'app']);
  order.setSourceOrder(['openhongguo', 'sdk', 'app', 'web']);
});
