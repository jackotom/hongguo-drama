// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const SOURCE_IDS = Object.freeze(['openhongguo', 'sdk', 'app', 'web']);
let activeOrder = [...SOURCE_IDS];

function normalizeSourceOrder(input) {
  const requested = Array.isArray(input) ? input.map(String) : [];
  const order = [];
  for (const id of requested) {
    if (SOURCE_IDS.includes(id) && !order.includes(id)) order.push(id);
  }
  for (const id of SOURCE_IDS) if (!order.includes(id)) order.push(id);
  return order;
}

function setSourceOrder(value) {
  activeOrder = normalizeSourceOrder(value);
  return [...activeOrder];
}

function getSourceOrder() {
  return [...activeOrder];
}

module.exports = { SOURCE_IDS, normalizeSourceOrder, setSourceOrder, getSourceOrder };
