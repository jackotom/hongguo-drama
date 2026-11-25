const assert = require('node:assert/strict');
const { test } = require('node:test');
const order = require('./source-order');

test('playback source order drops unknowns, duplicates and appends missing providers', () => {
  assert.deepEqual(order.normalizeSourceOrder(['sdk', 'bad', 'sdk', 'app']), ['sdk', 'app', 'web']);
  assert.deepEqual(order.normalizeSourceOrder([]), ['app', 'sdk', 'web']);
  assert.deepEqual(order.setSourceOrder(['web', 'sdk']), ['web', 'sdk', 'app']);
  assert.deepEqual(order.getSourceOrder(), ['web', 'sdk', 'app']);
  order.setSourceOrder(['app', 'sdk', 'web']);
});
