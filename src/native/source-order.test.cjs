const assert = require('node:assert/strict');
const { test } = require('node:test');
const order = require('./source-order');

test('playback source order drops unknowns, duplicates and appends missing providers', () => {
  assert.deepEqual(order.normalizeSourceOrder(['sdk', 'bad', 'sdk', 'app']), ['sdk', 'app', 'web', 'openhongguo']);
  assert.deepEqual(order.normalizeSourceOrder([]), ['app', 'sdk', 'web', 'openhongguo']);
  assert.deepEqual(order.setSourceOrder(['web', 'sdk']), ['web', 'sdk', 'app', 'openhongguo']);
  assert.deepEqual(order.getSourceOrder(), ['web', 'sdk', 'app', 'openhongguo']);
  order.setSourceOrder(['app', 'sdk', 'web', 'openhongguo']);
});
