const DEFAULT_STEALTH_WAKE_REGION = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

function validateStealthWakeRegion(value) {
  const keys = ['x', 'y', 'width', 'height'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key) && Number.isFinite(value[key]))
    || value.x < 0 || value.y < 0 || value.width < 0.05 || value.height < 0.05
    || value.x + value.width > 1 || value.y + value.height > 1) throw new Error('小窗唤醒区域无效：区域须在窗口内，宽高至少为 5%');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function normalizeStealthWakeRegion(value) {
  try { return validateStealthWakeRegion(value); }
  catch { return { ...DEFAULT_STEALTH_WAKE_REGION }; }
}
module.exports = { DEFAULT_STEALTH_WAKE_REGION, validateStealthWakeRegion, normalizeStealthWakeRegion };
