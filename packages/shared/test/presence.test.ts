import { describe, expect, it } from 'vitest';
import { decodeGeohashBBox, encodeGeohash, geohashCenter } from '../src/geo.ts';
import { CELL_HYSTERESIS } from '../src/constants.ts';
import {
  approxBlockBBox,
  approxCell,
  approxCellOf,
  displayPointInCell,
  insideDepthM,
  nextPresenceCell,
  presenceRoom,
} from '../src/presence.ts';

const MOSCOW = { lat: 55.7558, lng: 37.6176 };

describe('insideDepthM', () => {
  it('is largest at the center and zero outside', () => {
    const cell = encodeGeohash(MOSCOW.lat, MOSCOW.lng, 6);
    const [lng, lat] = geohashCenter(cell);
    const center = insideDepthM(lat, lng, cell);
    // p6 на широте Москвы ≈ 688×610 м → до ближайшей границы ~300 м
    expect(center).toBeGreaterThan(250);
    expect(center).toBeLessThan(360);
    const [w] = decodeGeohashBBox(cell);
    expect(insideDepthM(lat, w - 0.001, cell)).toBe(0);
  });
});

describe('nextPresenceCell', () => {
  it('accepts a decent first fix and rejects a terrible one', () => {
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: 40 })).toHaveLength(7);
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: 3000 })).toBeNull();
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: null })).toBeNull();
  });

  it('ignores fixes that stay in the same cell', () => {
    const cell = nextPresenceCell(null, { ...MOSCOW, accuracyM: 10 })!;
    expect(nextPresenceCell(cell, { ...MOSCOW, accuracyM: 10 })).toBeNull();
  });

  it('does not flip public cells on GPS jitter near the boundary', () => {
    const cell6 = encodeGeohash(MOSCOW.lat, MOSCOW.lng, 6);
    const [w, s, e, n] = decodeGeohashBBox(cell6);
    const midLat = (s + n) / 2;
    // стоим в 10 м к западу от восточной границы, дрожим на 10 м в соседнюю ячейку
    const mPerDegLng = 111_195 * Math.cos((midLat * Math.PI) / 180);
    const inside = { lat: midLat, lng: e - 10 / mPerDegLng, accuracyM: 15 };
    const across = { lat: midLat, lng: e + 10 / mPerDegLng, accuracyM: 15 };
    let current = nextPresenceCell(null, inside)!;
    let flips = 0;
    for (let i = 0; i < 20; i++) {
      const next = nextPresenceCell(current, i % 2 ? inside : across);
      if (next && next.slice(0, 6) !== current.slice(0, 6)) flips++;
      if (next) current = next;
    }
    expect(flips).toBe(0);
    expect(current.startsWith(cell6)).toBe(true);
    void w;
  });

  it('switches public cell after a real move deep into the neighbour', () => {
    const cell6 = encodeGeohash(MOSCOW.lat, MOSCOW.lng, 6);
    const [, s, e, n] = decodeGeohashBBox(cell6);
    const midLat = (s + n) / 2;
    const mPerDegLng = 111_195 * Math.cos((midLat * Math.PI) / 180);
    const start = nextPresenceCell(null, { lat: midLat, lng: e - 200 / mPerDegLng, accuracyM: 15 })!;
    const moved = nextPresenceCell(start, { lat: midLat, lng: e + 200 / mPerDegLng, accuracyM: 15 });
    expect(moved).not.toBeNull();
    expect(moved!.slice(0, 6)).not.toBe(cell6);
  });

  it('ignores inaccurate fixes once a cell is known', () => {
    const start = nextPresenceCell(null, { ...MOSCOW, accuracyM: 10 })!;
    expect(nextPresenceCell(start, { lat: MOSCOW.lat + 0.05, lng: MOSCOW.lng, accuracyM: 400 })).toBeNull();
  });
});

describe('displayPointInCell', () => {
  it('stays strictly inside the cell with a 15% margin', () => {
    const cell = 'ucfv0n';
    const [w, s, e, n] = decodeGeohashBBox(cell);
    for (const [fx, fy] of [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
      [-3, 9],
    ] as const) {
      const [lng, lat] = displayPointInCell(cell, fx, fy);
      expect(lng).toBeGreaterThanOrEqual(w + (e - w) * 0.149);
      expect(lng).toBeLessThanOrEqual(w + (e - w) * 0.851);
      expect(lat).toBeGreaterThanOrEqual(s + (n - s) * 0.149);
      expect(lat).toBeLessThanOrEqual(s + (n - s) * 0.851);
    }
  });
});

describe('presenceRoom', () => {
  it('derives rooms from the cell prefix', () => {
    expect(presenceRoom('ucfv0nr')).toBe('g5:ucfv0');
    expect(presenceRoom('ucfv0nr', 4)).toBe('g4:ucfv');
  });
});

describe('приблизительная геолокация', () => {
  const M_PER_DEG = 111_195;
  const block = approxBlockBBox(MOSCOW.lat, MOSCOW.lng);
  const [bw, bs, be, bn] = block;
  const at = (fx: number, fy: number) => ({ lat: bs + (bn - bs) * fy, lng: bw + (be - bw) * fx });

  it('первый грубый фикс 1800–3000 м даёт ячейку (раньше — null, и точка не публиковалась)', () => {
    for (const accuracyM of [1800, 2500, 3000]) {
      expect(nextPresenceCell(null, { ...MOSCOW, accuracyM }, { approx: true })).toHaveLength(7);
    }
  });

  it('квартал — 1–3 км по каждой стороне на широте Москвы', () => {
    const widthM = (be - bw) * M_PER_DEG * Math.cos((MOSCOW.lat * Math.PI) / 180);
    const heightM = (bn - bs) * M_PER_DEG;
    for (const side of [widthM, heightM]) {
      expect(side).toBeGreaterThan(1_000);
      expect(side).toBeLessThan(3_000);
    }
  });

  it('любая точка квартала даёт одну и ту же ячейку: квартал, а не точка', () => {
    const cells = new Set<string>();
    for (const fx of [0.05, 0.4, 0.95]) for (const fy of [0.05, 0.6, 0.95]) {
      const p = at(fx, fy);
      cells.add(approxCell(p.lat, p.lng));
    }
    expect(cells.size).toBe(1);
  });

  it('блюр сильнее точного режима: четыре публичные ячейки квартала сливаются в одну', () => {
    const quarters = [at(0.25, 0.25), at(0.75, 0.25), at(0.25, 0.75), at(0.75, 0.75)];
    expect(new Set(quarters.map((p) => encodeGeohash(p.lat, p.lng, 6))).size).toBe(4);
    expect(new Set(quarters.map((p) => approxCell(p.lat, p.lng).slice(0, 6))).size).toBe(1);
  });

  it('неизвестная точность принимается, совсем грубая — нет', () => {
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: null }, { approx: true })).toHaveLength(7);
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: CELL_HYSTERESIS.approxMaxAccuracyM + 1 }, { approx: true })).toBeNull();
  });

  it('гистерезис квартала: у края не прыгает, глубоко в соседнем — переходит', () => {
    const start = approxCell(MOSCOW.lat, MOSCOW.lng);
    const midLat = (bs + bn) / 2;
    const mPerDegLng = M_PER_DEG * Math.cos((midLat * Math.PI) / 180);
    const nearEdge = { lat: midLat, lng: be + 50 / mPerDegLng, accuracyM: 2000 };
    const deep = { lat: midLat, lng: be + 400 / mPerDegLng, accuracyM: 2000 };
    expect(nextPresenceCell(start, nearEdge, { approx: true })).toBeNull();
    const moved = nextPresenceCell(start, deep, { approx: true });
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(start);
    expect(moved).toBe(approxCell(deep.lat, deep.lng));
  });

  it('approxCellOf огрубляет точную ячейку до её квартала', () => {
    const precise = encodeGeohash(MOSCOW.lat, MOSCOW.lng, 7);
    expect(approxCellOf(precise)).toBe(approxCell(MOSCOW.lat, MOSCOW.lng));
  });

  it('точный режим не изменился: 80 м → ячейка точки, 2000 м → null', () => {
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: 80 })).toBe(encodeGeohash(MOSCOW.lat, MOSCOW.lng, 7));
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: 2000 })).toBeNull();
    expect(nextPresenceCell(null, { ...MOSCOW, accuracyM: 80 }, { approx: false })).toBe(encodeGeohash(MOSCOW.lat, MOSCOW.lng, 7));
  });
});
