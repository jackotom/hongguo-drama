// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const ROUTE_IDS = new Set([
  'preload_current', 'video_tab', 'player_b', 'player_a', 'model_0', 'model_1', 'legacy',
]);
const SAFE_HOSTS = ['fqnovel.com', 'snssdk.com'];
const AUTH_MODES = new Set(['v5', 'player', 'none']);
const HEADER_NAMES = new Set(['user-agent', 'accept']);
const PROTECTED_QUERY_FIELDS = new Set(['iid', 'cdid', 'device_id', 'ts', '_rticket']);
const MAX_VALUE_LENGTH = 256;

let activePolicy = Object.freeze({ revision: 0, routes: Object.freeze([]) });

function safeUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !SAFE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('动态取源地址不是受支持的红果官方 HTTPS 域名');
  }
  url.hash = '';
  return url.href;
}

function safeMap(value, label) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须为对象`);
  const entries = Object.entries(value);
  if (entries.length > 40) throw new Error(`${label}字段过多`);
  const result = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) throw new Error(`${label}字段名无效`);
    if (key.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new Error(`${label}字段名无效`);
    }
    if (label === '查询字段' && PROTECTED_QUERY_FIELDS.has(key)) throw new Error(`不允许动态覆盖身份或时间字段 ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${label}字段值类型无效`);
    const text = String(raw);
    if (text.length > MAX_VALUE_LENGTH) throw new Error(`${label}字段值过长`);
    result[key] = raw;
  }
  return result;
}

function safeHeaders(value) {
  const map = safeMap(value, '请求头');
  const result = {};
  for (const [key, raw] of Object.entries(map)) {
    const name = key.toLowerCase();
    if (!HEADER_NAMES.has(name)) throw new Error(`不允许动态修改请求头 ${key}`);
    result[name] = String(raw);
  }
  return result;
}

function normalizePolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('动态取源策略格式无效');
  const revision = Number(input.revision);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000_000_000) throw new Error('动态取源策略版本无效');
  const routes = Array.isArray(input.routes) ? input.routes : [];
  if (routes.length > ROUTE_IDS.size) throw new Error('动态取源入口数量过多');
  const seen = new Set();
  const normalized = routes.map(route => {
    if (!route || typeof route !== 'object' || !ROUTE_IDS.has(route.id)) throw new Error('动态取源入口不支持');
    if (seen.has(route.id)) throw new Error('动态取源入口重复');
    seen.add(route.id);
    const order = Number(route.order ?? 100);
    if (!Number.isSafeInteger(order) || order < 0 || order > 1000) throw new Error('动态取源入口顺序无效');
    const auth = String(route.auth || 'v5');
    if (!AUTH_MODES.has(auth)) throw new Error('动态取源签名方式不支持');
    return {
      id: route.id,
      enabled: route.enabled !== false,
      order,
      auth,
      ...(route.url ? { url: safeUrl(route.url) } : {}),
      ...(route.values ? { values: safeMap(route.values, '查询字段') } : {}),
      ...(route.body ? { body: safeMap(route.body, '请求正文字段') } : {}),
      ...(route.headers ? { headers: safeHeaders(route.headers) } : {}),
      ...(route.field21 != null ? { field21: Math.max(0, Math.min(1_000_000, Number(route.field21) || 0)) } : {}),
    };
  });
  return Object.freeze({ revision, routes: Object.freeze(normalized) });
}

function setPolicy(policy) {
  activePolicy = policy ? normalizePolicy(policy) : Object.freeze({ revision: 0, routes: Object.freeze([]) });
  return activePolicy;
}

function getPolicy() {
  return activePolicy;
}

function route(id) {
  return activePolicy.routes.find(item => item.id === id) || null;
}

function applyRoutes(defaults) {
  if (!Array.isArray(defaults)) throw new Error('默认取源入口无效');
  const defaultsById = new Map(defaults.map(item => [item.id, item]));
  for (const item of activePolicy.routes) {
    if (defaultsById.has(item.id)) defaultsById.set(item.id, { ...defaultsById.get(item.id), ...item });
  }
  const seen = new Set();
  return [...defaultsById.values()]
    .filter(item => item.enabled !== false)
    .sort((a, b) => Number(a.order ?? 100) - Number(b.order ?? 100))
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

module.exports = { normalizePolicy, setPolicy, getPolicy, route, applyRoutes, ROUTE_IDS };
