const SENSITIVE_ASSIGNMENT = /\b(Bearer|decryption_key)\s+\S+/gi;
const HTTP_URL = /\bhttps?:\/\/[^\s<>"'）]+/gi;

function safeErrorText(value, maxLength = 600) {
  const text = String(value ?? '操作失败')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1[认证已隐藏]@')
    .replace(SENSITIVE_ASSIGNMENT, '$1 [已隐藏]')
    .replace(HTTP_URL, raw => {
      const trailing = raw.match(/[),.;!?]+$/)?.[0] || '';
      const clean = trailing ? raw.slice(0, -trailing.length) : raw;
      try {
        const url = new URL(clean);
        return `${url.origin}/...${trailing}`;
      } catch {
        return `[来源地址已隐藏]${trailing}`;
      }
    });
  return Array.from(text).slice(0, maxLength).join('');
}

const ERROR_FIELDS = /^(?:error|apiError|warning|reason|lastCheckError|lastEpisodeCheckError|lastSequelCheckError)$/i;

function sanitizeIpcValue(value, depth = 0, seen = new WeakMap()) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value !== 'object' || depth > 8) return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(sanitizeIpcValue(item, depth + 1, seen));
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
  const copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = typeof item === 'string' && ERROR_FIELDS.test(key)
      ? safeErrorText(item)
      : sanitizeIpcValue(item, depth + 1, seen);
  }
  return copy;
}

function sanitizeLogValue(value) {
  if (typeof value === 'string') return safeErrorText(value, 4000);
  if (value instanceof Error) {
    const copy = new Error(safeErrorText(value.message, 4000));
    copy.name = value.name;
    copy.stack = value.stack ? safeErrorText(value.stack, 8000) : undefined;
    if (value.code) copy.code = value.code;
    return copy;
  }
  return value;
}

module.exports = { safeErrorText, sanitizeIpcValue, sanitizeLogValue };
