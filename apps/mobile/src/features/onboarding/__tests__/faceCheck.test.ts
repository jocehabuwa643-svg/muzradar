import { checkFaces, faceSquare, type DetectedFace, type FaceRect } from '../faceCheck';

const W = 720;
const H = 960;

/** Лицо с центром в долях кадра и шириной в долях ширины; высота — 1.2 ширины, как у реальной рамки ML Kit. */
function face(cx: number, cy: number, widthRatio: number, angles: { yaw?: number; roll?: number; hasYaw?: boolean; hasRoll?: boolean } = {}): DetectedFace {
  const w = widthRatio * W;
  const h = w * 1.2;
  return {
    frame: { origin: { x: cx * W - w / 2, y: cy * H - h / 2 }, size: { x: w, y: h } },
    hasHeadEulerAngleY: angles.hasYaw ?? angles.yaw !== undefined,
    headEulerAngleY: angles.yaw ?? null,
    hasHeadEulerAngleZ: angles.hasRoll ?? angles.roll !== undefined,
    headEulerAngleZ: angles.roll ?? null,
  };
}

describe('checkFaces', () => {
  test.each<[string, DetectedFace[], ReturnType<typeof checkFaces>]>([
    ['нет лиц', [], 'none'],
    ['два лица', [face(0.5, 0.45, 0.4), face(0.2, 0.3, 0.2)], 'many'],
    ['ровно по центру, 40 % ширины', [face(0.5, 0.45, 0.4)], 'ok'],
    ['в допуске по горизонтали (0.64)', [face(0.64, 0.45, 0.4)], 'ok'],
    ['смещено вправо (0.66)', [face(0.66, 0.45, 0.4)], 'off-center'],
    ['смещено влево (0.3)', [face(0.3, 0.45, 0.4)], 'off-center'],
    ['в допуске по вертикали (0.62)', [face(0.5, 0.62, 0.3)], 'ok'],
    ['слишком низко (0.7)', [face(0.5, 0.7, 0.3)], 'off-center'],
    ['слишком высоко (0.2)', [face(0.5, 0.2, 0.3)], 'off-center'],
    ['мелкое (20 %)', [face(0.5, 0.45, 0.2)], 'too-small'],
    ['на границе мелкого (26 %)', [face(0.5, 0.45, 0.26)], 'ok'],
    ['крупное (85 %)', [face(0.5, 0.45, 0.85)], 'too-big'],
    ['на границе крупного (79 %)', [face(0.5, 0.45, 0.79)], 'ok'],
    ['поворот 25°', [face(0.5, 0.45, 0.4, { yaw: 25 })], 'turned'],
    ['поворот −25°', [face(0.5, 0.45, 0.4, { yaw: -25 })], 'turned'],
    ['поворот 19°', [face(0.5, 0.45, 0.4, { yaw: 19 })], 'ok'],
    ['наклон 16°', [face(0.5, 0.45, 0.4, { roll: 16 })], 'turned'],
    ['наклон −14°', [face(0.5, 0.45, 0.4, { roll: -14 })], 'ok'],
    ['угол есть, но флаг hasHeadEulerAngleY=false', [face(0.5, 0.45, 0.4, { yaw: 40, hasYaw: false })], 'ok'],
    ['флаг есть, угол null', [face(0.5, 0.45, 0.4, { hasYaw: true })], 'ok'],
  ])('%s → %s', (_name, faces, verdict) => {
    expect(checkFaces(faces, W, H)).toBe(verdict);
  });

  test('сначала «несколько лиц», потом всё остальное', () => {
    expect(checkFaces([face(0.1, 0.1, 0.05), face(0.9, 0.9, 0.9)], W, H)).toBe('many');
  });

  test('кадр нулевого размера не считается удачным', () => {
    expect(checkFaces([face(0.5, 0.45, 0.4)], 0, H)).toBe('none');
    expect(checkFaces([face(0.5, 0.45, 0.4)], W, Number.NaN)).toBe('none');
  });
});

describe('faceSquare', () => {
  const rect = (x: number, y: number, w: number, h: number): FaceRect => ({ origin: { x, y }, size: { x: w, y: h } });

  test.each<[string, FaceRect, number, number, ReturnType<typeof faceSquare>]>([
    // сторона 360·1.7 = 612; центр y = 312 − 28.8 → квадрат упирается в верх кадра
    ['лицо по центру', rect(210, 132, 300, 360), 720, 960, { originX: 54, originY: 0, width: 612, height: 612 }],
    ['лицо у правого края сдвигается внутрь', rect(600, 400, 200, 200), 720, 960, { originX: 380, originY: 314, width: 340, height: 340 }],
    ['лицо больше кадра — квадрат во всю короткую сторону', rect(-100, -100, 1000, 1200), 720, 960, { originX: 0, originY: 44, width: 720, height: 720 }],
    ['альбомный кадр', rect(300, 100, 200, 240), 960, 540, { originX: 196, originY: 0, width: 408, height: 408 }],
  ])('%s', (_name, r, w, h, expected) => {
    expect(faceSquare(r, w, h)).toEqual(expected);
  });

  test('никогда не выходит за кадр и всегда квадратный (перебор)', () => {
    // детерминированный генератор: воспроизводимые случаи без внешних зависимостей
    let seed = 42;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 2000; i++) {
      const W2 = 64 + Math.floor(rnd() * 1400);
      const H2 = 64 + Math.floor(rnd() * 1400);
      const r = rect(rnd() * W2 * 1.4 - W2 * 0.2, rnd() * H2 * 1.4 - H2 * 0.2, 1 + rnd() * W2 * 1.2, 1 + rnd() * H2 * 1.2);
      const margin = 1 + rnd() * 2;
      const box = faceSquare(r, W2, H2, margin);
      expect(box.width).toBe(box.height);
      expect(box.width).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(box.originX) && Number.isInteger(box.originY) && Number.isInteger(box.width)).toBe(true);
      expect(box.originX).toBeGreaterThanOrEqual(0);
      expect(box.originY).toBeGreaterThanOrEqual(0);
      expect(box.originX + box.width).toBeLessThanOrEqual(W2);
      expect(box.originY + box.height).toBeLessThanOrEqual(H2);
    }
  });

  test('пустой кадр даёт пустой прямоугольник, а не отрицательный', () => {
    expect(faceSquare(rect(0, 0, 10, 10), 0, 0)).toEqual({ originX: 0, originY: 0, width: 0, height: 0 });
  });
});
