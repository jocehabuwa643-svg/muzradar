import { describe, expect, it } from 'vitest';
import {
  coverBBox,
  decodeGeohashBBox,
  encodeGeohash,
  geohashCellSize,
  geohashCenter,
  isGeohash,
  motionFromSpeed,
} from '../src/geo.ts';

describe('geohash', () => {
  it('matches reference vectors', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj');
    expect(encodeGeohash(42.605, -5.603, 5)).toBe('ezs42');
    expect(encodeGeohash(55.7558, 37.6176, 7).startsWith('ucfv0')).toBe(true);
  });

  it('decodes to a bbox containing the source point', () => {
    const [w, s, e, n] = decodeGeohashBBox(encodeGeohash(55.7558, 37.6176, 7));
    expect(w).toBeLessThanOrEqual(37.6176);
    expect(e).toBeGreaterThanOrEqual(37.6176);
    expect(s).toBeLessThanOrEqual(55.7558);
    expect(n).toBeGreaterThanOrEqual(55.7558);
  });

  it('round-trips the center', () => {
    const hash = 'ucfv0nr';
    const [lng, lat] = geohashCenter(hash);
    expect(encodeGeohash(lat, lng, 7)).toBe(hash);
  });

  it('cell sizes shrink with precision', () => {
    const p6 = geohashCellSize(6);
    const p7 = geohashCellSize(7);
    expect(p6.lng).toBeCloseTo(0.010986, 5);
    expect(p6.lat).toBeCloseTo(0.005493, 5);
    expect(p7.lng).toBeLessThan(p6.lng);
  });

  it('rejects junk', () => {
    expect(isGeohash('ucfv0nr')).toBe(true);
    expect(isGeohash('ucfv0a')).toBe(false); // 'a' не входит в алфавит
    expect(isGeohash('')).toBe(false);
    expect(() => encodeGeohash(91, 0, 5)).toThrow(RangeError);
    expect(() => decodeGeohashBBox('ail')).toThrow(RangeError);
  });

  it('covers a viewport and every covered point maps to a returned cell', () => {
    const bbox = [37.5, 55.7, 37.7, 55.8] as const;
    const cells = coverBBox(bbox, 5, 64);
    expect(cells).not.toBeNull();
    const set = new Set(cells);
    for (let lat = 55.7; lat <= 55.8; lat += 0.01) {
      for (let lng = 37.5; lng <= 37.7; lng += 0.01) {
        expect(set.has(encodeGeohash(lat, lng, 5))).toBe(true);
      }
    }
  });

  it('refuses to cover huge viewports at fine precision', () => {
    expect(coverBBox([20, 40, 60, 70], 5, 64)).toBeNull();
    expect(coverBBox([20, 40, 60, 70], 2, 64)).not.toBeNull();
  });

  it('classifies motion by speed', () => {
    expect(motionFromSpeed(null)).toBe('still');
    expect(motionFromSpeed(-1)).toBe('still');
    expect(motionFromSpeed(1.4)).toBe('walk');
    expect(motionFromSpeed(15)).toBe('drive');
  });
});
