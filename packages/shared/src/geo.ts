/**
 * Минимальный geohash без зависимостей: одинаково работает в Hermes и Node.
 * Координаты в МУЗРАДАРЕ существуют только на устройстве — наружу уходит ячейка.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const BASE32_INDEX: Record<string, number> = Object.fromEntries(
  [...BASE32].map((c, i) => [c, i]),
);

export type LngLat = readonly [lng: number, lat: number];
/** [west, south, east, north] */
export type BBox = readonly [w: number, s: number, e: number, n: number];

export const GEOHASH_RE = /^[0-9b-hjkmnp-z]{1,12}$/;

export function isGeohash(value: string): boolean {
  return GEOHASH_RE.test(value);
}

export function encodeGeohash(lat: number, lng: number, precision: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RangeError('bad coordinates');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new RangeError('coordinates out of range');
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bit = 0;
  let ch = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        ch = (ch << 1) | 1;
        lngMin = mid;
      } else {
        ch <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        ch = (ch << 1) | 1;
        latMin = mid;
      } else {
        ch <<= 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

export function decodeGeohashBBox(hash: string): BBox {
  if (!isGeohash(hash)) throw new RangeError(`bad geohash: ${hash}`);
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let evenBit = true;
  for (const c of hash) {
    const idx = BASE32_INDEX[c]!;
    for (let n = 4; n >= 0; n--) {
      const bitN = (idx >> n) & 1;
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2;
        if (bitN === 1) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bitN === 1) latMin = mid;
        else latMax = mid;
      }
      evenBit = !evenBit;
    }
  }
  return [lngMin, latMin, lngMax, latMax];
}

export function geohashCenter(hash: string): LngLat {
  const [w, s, e, n] = decodeGeohashBBox(hash);
  return [(w + e) / 2, (s + n) / 2];
}

/** Размер ячейки в градусах для точности p. */
export function geohashCellSize(precision: number): { lng: number; lat: number } {
  const bits = precision * 5;
  const lngBits = Math.ceil(bits / 2);
  const latBits = Math.floor(bits / 2);
  return { lng: 360 / 2 ** lngBits, lat: 180 / 2 ** latBits };
}

/**
 * Ячейки точности p, покрывающие bbox. Возвращает null, если их больше maxCells —
 * вызывающий должен взять точность грубее.
 */
export function coverBBox(bbox: BBox, precision: number, maxCells: number): string[] | null {
  const [w, s, e, n] = bbox;
  if (!(w <= e && s <= n)) return null;
  const size = geohashCellSize(precision);
  const cols = Math.floor((e - w) / size.lng) + 2;
  const rows = Math.floor((n - s) / size.lat) + 2;
  if (cols * rows > maxCells * 4) return null;
  const out = new Set<string>();
  const clampLat = (v: number) => Math.min(90, Math.max(-90, v));
  const clampLng = (v: number) => Math.min(180, Math.max(-180, v));
  for (let lat = s; lat <= n + size.lat; lat += size.lat) {
    for (let lng = w; lng <= e + size.lng; lng += size.lng) {
      out.add(encodeGeohash(clampLat(Math.min(lat, n)), clampLng(Math.min(lng, e)), precision));
      if (out.size > maxCells) return null;
    }
  }
  return [...out];
}

export type Motion = 'still' | 'walk' | 'drive';

/** Скорость из GPS (м/с, может быть null/-1) → грубое состояние движения. */
export function motionFromSpeed(speedMps: number | null | undefined): Motion {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < 0.8) return 'still';
  if (speedMps < 3.5) return 'walk';
  return 'drive';
}
