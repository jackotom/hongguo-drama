export const FULL_WAKE_REGION = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });
export const RIGHT_WAKE_REGION = Object.freeze({ x: 0.9, y: 0, width: 0.1, height: 1 });
const keys = ['x', 'y', 'width', 'height'];

export function validWakeRegion(value) {
  return value && keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
    value.x >= 0 && value.y >= 0 && value.width >= 0.05 && value.height >= 0.05 &&
    value.x + value.width <= 1 && value.y + value.height <= 1;
}

export function wakeRegionFields(value) {
  const region = validWakeRegion(value) ? value : FULL_WAKE_REGION;
  return Object.fromEntries(keys.map(key => [key, String(Number((region[key] * 100).toFixed(8)))]));
}

export function wakeRegionFromFields(fields) {
  if (!keys.every(key => typeof fields[key] === 'string' && fields[key].trim() !== '' && Number.isFinite(Number(fields[key])))) return null;
  const values = Object.fromEntries(keys.map(key => [key, Number(fields[key])]));
  if (values.x < 0 || values.y < 0 || values.width < 5 || values.height < 5 ||
      values.x + values.width > 100 || values.y + values.height > 100) return null;
  const x = values.x / 100, y = values.y / 100;
  const width = values.width / 100, height = values.height / 100;
  // Bound rounding at the right/bottom edges before the native strict validation.
  return { x, y, width: x + width > 1 ? 1 - x : width, height: y + height > 1 ? 1 - y : height };
}

export function adjustWakeRegion(region, dx, dy, resize = false) {
  if (![dx, dy].every(Number.isFinite)) return region;
  const round = value => Math.round(value * 1000) / 1000;
  return resize
    ? { ...region, width: Math.min(1 - region.x, Math.max(0.05, round(region.width + dx))), height: Math.min(1 - region.y, Math.max(0.05, round(region.height + dy))) }
    : { ...region, x: Math.min(1 - region.width, Math.max(0, round(region.x + dx))), y: Math.min(1 - region.height, Math.max(0, round(region.y + dy))) };
}
