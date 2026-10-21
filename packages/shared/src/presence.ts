import { CELL_HYSTERESIS, GEO_PRECISION } from './constants.ts';
import { decodeGeohashBBox, encodeGeohash, geohashCenter, type BBox, type LngLat } from './geo.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

function insideDepthBBoxM(lat: number, lng: number, [w, s, e, n]: BBox): number {
  if (lat < s || lat > n || lng < w || lng > e) return 0;
  const mPerDegLat = EARTH_RADIUS_M * DEG;
  const mPerDegLng = mPerDegLat * Math.cos(lat * DEG);
  return Math.min((lat - s) * mPerDegLat, (n - lat) * mPerDegLat, (lng - w) * mPerDegLng, (e - lng) * mPerDegLng);
}

/** Минимальное расстояние (м) от точки внутри ячейки до её границы; 0, если точка снаружи. */
export function insideDepthM(lat: number, lng: number, cell: string): number {
  return insideDepthBBoxM(lat, lng, decodeGeohashBBox(cell));
}

// Квартал приблизительного пользователя — блок 2×2 публичных ячеек: 14 бит долготы × 14 бит широты
// против 15×15 у публичной ячейки (≈1,4×1,2 км в Москве). Фикс с точностью 1–3 км не должен
// выглядеть точнее, чем он есть, и не должен менять ячейку от каждого скачка грубой точки.
const APPROX_BLOCK_BITS = 14;
const APPROX_LNG_STEP = 360 / 2 ** APPROX_BLOCK_BITS;
const APPROX_LAT_STEP = 180 / 2 ** APPROX_BLOCK_BITS;
const APPROX_LAST_INDEX = 2 ** APPROX_BLOCK_BITS - 1;

/** Квартал, в который попадает точка. */
export function approxBlockBBox(lat: number, lng: number): BBox {
  const x = Math.min(Math.floor((lng + 180) / APPROX_LNG_STEP), APPROX_LAST_INDEX);
  const y = Math.min(Math.floor((lat + 90) / APPROX_LAT_STEP), APPROX_LAST_INDEX);
  const w = -180 + x * APPROX_LNG_STEP;
  const s = -90 + y * APPROX_LAT_STEP;
  return [w, s, w + APPROX_LNG_STEP, s + APPROX_LAT_STEP];
}

/**
 * Ячейка приблизительного пользователя: центр его квартала, а не точка фикса.
 * Любая точка квартала даёт одну и ту же ячейку — по ней нельзя понять, где внутри квартала человек.
 */
export function approxCell(lat: number, lng: number): string {
  const [w, s, e, n] = approxBlockBBox(lat, lng);
  return encodeGeohash((s + n) / 2, (w + e) / 2, GEO_PRECISION.client);
}

/** Огрубить уже известную точную ячейку до квартала — когда пользователь выключил точную геопозицию. */
export function approxCellOf(cell: string): string {
  const [lng, lat] = geohashCenter(cell);
  return approxCell(lat, lng);
}

export interface LocationFix {
  lat: number;
  lng: number;
  /** Горизонтальная точность, м; null — неизвестна. */
  accuracyM: number | null;
}

export interface PresenceCellOptions {
  /** Пользователь выдал только приблизительную геолокацию. */
  approx?: boolean;
}

/**
 * Приблизительный режим: ячейка квартала. Точность не проверяем строго — наружу всё равно уходит
 * только квартал; неизвестную точность тоже принимаем, иначе пользователь невидим.
 */
function nextApproxCell(prevCell: string | null, fix: LocationFix): string | null {
  if ((fix.accuracyM ?? 0) > CELL_HYSTERESIS.approxMaxAccuracyM) return null;
  const cell = approxCell(fix.lat, fix.lng);
  if (prevCell === null) return cell;
  if (cell === prevCell) return null;
  const depth = insideDepthBBoxM(fix.lat, fix.lng, approxBlockBBox(fix.lat, fix.lng));
  return depth >= CELL_HYSTERESIS.approxSwitchDepthM ? cell : null;
}

/**
 * Решает, какую ячейку (точности GEO_PRECISION.client) отправить после нового фикса.
 * Возвращает null, если фикс надо проигнорировать и оставить прежнюю ячейку.
 * prevCell должна быть получена в том же режиме: при смене режима передавайте null.
 * Координаты дальше этой функции не уходят.
 */
export function nextPresenceCell(prevCell: string | null, fix: LocationFix, opts: PresenceCellOptions = {}): string | null {
  if (opts.approx) return nextApproxCell(prevCell, fix);
  const acc = fix.accuracyM ?? Number.POSITIVE_INFINITY;
  const cell = encodeGeohash(fix.lat, fix.lng, GEO_PRECISION.client);
  if (prevCell === null) return acc <= CELL_HYSTERESIS.firstFixMaxAccuracyM ? cell : null;
  if (cell === prevCell) return null;
  if (acc > CELL_HYSTERESIS.maxAccuracyM) return null;

  const publicPrev = prevCell.slice(0, GEO_PRECISION.public);
  const publicNext = cell.slice(0, GEO_PRECISION.public);
  if (publicPrev !== publicNext) {
    const depth = insideDepthM(fix.lat, fix.lng, publicNext);
    return depth >= CELL_HYSTERESIS.publicSwitchDepthM ? cell : null;
  }
  return insideDepthM(fix.lat, fix.lng, cell) >= CELL_HYSTERESIS.fineSwitchDepthM ? cell : null;
}

/**
 * Точка отображения внутри ячейки по двум долям [0..1] (сервер берёт их из HMAC).
 * Доли сжимаются в 15–85 %, чтобы маркер не лип к границе.
 */
export function displayPointInCell(cell: string, fx: number, fy: number): LngLat {
  const [w, s, e, n]: BBox = decodeGeohashBBox(cell);
  const clamp = (v: number) => 0.15 + Math.min(1, Math.max(0, v)) * 0.7;
  const lng = w + (e - w) * clamp(fx);
  const lat = s + (n - s) * clamp(fy);
  return [Number(lng.toFixed(5)), Number(lat.toFixed(5))];
}

/** Комната реалтайма для ячейки. */
export function presenceRoom(cell: string, precision: number = GEO_PRECISION.roomFine): string {
  return `g${precision}:${cell.slice(0, precision)}`;
}
