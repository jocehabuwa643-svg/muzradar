// Чистая логика проверки кадра для аватара: без нативных модулей, чтобы гонять её в Jest таблицами.

/** Прямоугольник в пикселях входного изображения (как RNMLKitRect: size.x — ширина, size.y — высота). */
export interface FaceRect {
  origin: { x: number; y: number };
  size: { x: number; y: number };
}

/** Структурное подмножество RNMLKitFace — ровно то, что нужно проверке. */
export interface DetectedFace {
  frame: FaceRect;
  hasHeadEulerAngleY: boolean;
  headEulerAngleY?: number | null;
  hasHeadEulerAngleZ: boolean;
  headEulerAngleZ?: number | null;
}

export type FaceVerdict = 'ok' | 'none' | 'many' | 'off-center' | 'too-small' | 'too-big' | 'turned';

/**
 * Пороги — эвристики из исследования, их нужно подстроить на живых устройствах.
 * Центр по вертикали чуть выше середины: круг-маска на экране стоит на 45 % высоты.
 */
export const FACE_RULES = {
  centerX: 0.5,
  centerXTolerance: 0.15,
  centerY: 0.45,
  centerYTolerance: 0.2,
  minWidthRatio: 0.25,
  maxWidthRatio: 0.8,
  /** Поворот головы влево-вправо. */
  maxYawDeg: 20,
  /** Наклон головы к плечу. */
  maxRollDeg: 15,
} as const;

export function checkFaces(faces: readonly DetectedFace[], W: number, H: number): FaceVerdict {
  if (!(W > 0) || !(H > 0)) return 'none';
  if (faces.length === 0) return 'none';
  if (faces.length > 1) return 'many';
  const face = faces[0]!;
  const { origin: o, size: s } = face.frame;
  const cx = (o.x + s.x / 2) / W;
  const cy = (o.y + s.y / 2) / H;
  const widthRatio = s.x / W;
  if (Math.abs(cx - FACE_RULES.centerX) > FACE_RULES.centerXTolerance || Math.abs(cy - FACE_RULES.centerY) > FACE_RULES.centerYTolerance) {
    return 'off-center';
  }
  if (widthRatio < FACE_RULES.minWidthRatio) return 'too-small';
  if (widthRatio > FACE_RULES.maxWidthRatio) return 'too-big';
  const yaw = face.hasHeadEulerAngleY ? Math.abs(face.headEulerAngleY ?? 0) : 0;
  const roll = face.hasHeadEulerAngleZ ? Math.abs(face.headEulerAngleZ ?? 0) : 0;
  if (yaw > FACE_RULES.maxYawDeg || roll > FACE_RULES.maxRollDeg) return 'turned';
  return 'ok';
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/**
 * Квадрат вокруг лица с запасом, строго внутри кадра.
 * Зажимать обязательно: кроп на Android проверяет только originX ≤ W и width ≤ W (не их сумму)
 * и падает в Bitmap.createBitmap, а iOS молча обрезает прямоугольник — и квадрат перестаёт быть квадратом.
 */
export function faceSquare(rect: FaceRect, W: number, H: number, margin = 1.7): CropRect {
  const maxSide = Math.floor(Math.min(W, H));
  if (maxSide < 1) return { originX: 0, originY: 0, width: 0, height: 0 };
  const cx = rect.origin.x + rect.size.x / 2;
  // рамка ML Kit не включает волосы — центр квадрата чуть выше центра лица
  const cy = rect.origin.y + rect.size.y / 2 - rect.size.y * 0.08;
  const wanted = Math.max(rect.size.x, rect.size.y) * margin;
  const side = Math.max(1, Math.floor(Math.min(Number.isFinite(wanted) ? wanted : maxSide, maxSide)));
  const x = clamp(Math.round(cx - side / 2), 0, Math.floor(W - side));
  const y = clamp(Math.round(cy - side / 2), 0, Math.floor(H - side));
  const s = Math.floor(Math.min(side, W - x, H - y));
  return { originX: x, originY: y, width: s, height: s };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(v, max));
}

/** Конкретная причина — чтобы человек понял, что поменять, а не просто «не получилось». */
export const FACE_VERDICT_MESSAGES: Record<FaceVerdict, { title: string; hint: string }> = {
  ok: { title: 'Отличный кадр', hint: 'Лицо в круге, смотрите прямо.' },
  none: { title: 'Лица не видно', hint: 'Встаньте лицом к свету и поместите лицо в круг.' },
  many: { title: 'В кадре несколько лиц', hint: 'Нужно только ваше — попросите остальных отойти.' },
  'off-center': { title: 'Лицо не в центре', hint: 'Держите телефон ровно, лицо — в круге.' },
  'too-small': { title: 'Подойдите ближе', hint: 'Лицо должно заполнить круг.' },
  'too-big': { title: 'Слишком близко', hint: 'Отведите телефон чуть дальше.' },
  turned: { title: 'Смотрите прямо', hint: 'Не поворачивайте и не наклоняйте голову.' },
};
