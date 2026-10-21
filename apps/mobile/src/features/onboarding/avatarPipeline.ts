import { LIMITS } from '@muzradar/shared';
import { ImageManipulator, SaveFormat, type ImageManipulatorContext, type ImageRef, type SaveOptions } from 'expo-image-manipulator';
import { checkFaces, faceSquare, type FaceVerdict } from './faceCheck';
import { mlkitFaceDetector, type FaceDetector } from './faceDetector';

export interface AvatarImage {
  /** Локальный файл 128×128 WebP — для предпросмотра. */
  uri: string;
  base64: string;
  bytes: number;
}

export type AvatarFailure = Exclude<FaceVerdict, 'ok'> | 'too-heavy' | 'failed';

export type AvatarResult = { ok: true; avatar: AvatarImage } | { ok: false; reason: AvatarFailure; error?: unknown };

/** 720 px: лицо на 25 % кадра — около 180 px, выше минимума ML Kit, а декод и детекция остаются быстрыми. */
const NORMALIZED_WIDTH = 720;
/** Шумный снимок в темноте может не влезть в лимит — тогда пережимаем сильнее, а не отказываем. */
const WEBP_QUALITY_STEPS = [0.6, 0.45, 0.3] as const;

export const AVATAR_FAILURE_MESSAGES: Record<'too-heavy' | 'failed', { title: string; hint: string }> = {
  'too-heavy': { title: 'Снимок получился слишком тяжёлым', hint: 'Переснимите при ровном свете.' },
  failed: { title: 'Не получилось обработать снимок', hint: 'Попробуйте ещё раз.' },
};

async function renderOnce(ctx: ImageManipulatorContext): Promise<ImageRef> {
  try {
    return await ctx.renderAsync();
  } finally {
    ctx.release();
  }
}

/** Байты по длине base64 (без учёта переносов, которые мы уже вырезали). */
export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** Без префикса data: и переносов строк — сервер ждёт чистый base64. */
export function cleanBase64(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
}

/**
 * Снимок камеры → аватар 128×128 WebP:
 * нормализация до 720 px JPEG → детекция лица → проверка кадра → квадрат по лицу → 128×128 → WebP q0.6.
 * Детекция и кроп идут по одному и тому же нормализованному файлу — координаты рамки совпадают с пикселями.
 */
export async function buildAvatar(photoUri: string, detector: FaceDetector = mlkitFaceDetector): Promise<AvatarResult> {
  try {
    const normRef = await renderOnce(ImageManipulator.manipulate(photoUri).resize({ width: NORMALIZED_WIDTH }));
    let norm: { uri: string; width: number; height: number };
    try {
      norm = await normRef.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
    } finally {
      normRef.release();
    }

    const faces = await detector.detect(norm.uri);
    const verdict = checkFaces(faces, norm.width, norm.height);
    if (verdict !== 'ok') return { ok: false, reason: verdict };

    const box = faceSquare(faces[0]!.frame, norm.width, norm.height);
    if (box.width < 1) return { ok: false, reason: 'failed' };

    const outRef = await renderOnce(
      ImageManipulator.manipulate(norm.uri).crop(box).resize({ width: LIMITS.avatarSide, height: LIMITS.avatarSide }),
    );
    try {
      for (const compress of WEBP_QUALITY_STEPS) {
        const options: SaveOptions = { format: SaveFormat.WEBP, compress, base64: true };
        const out = await outRef.saveAsync(options);
        const base64 = cleanBase64(out.base64);
        if (!base64) return { ok: false, reason: 'failed', error: new Error('saveAsync вернул пустой base64') };
        if (base64.length <= LIMITS.avatarBase64Max) {
          return { ok: true, avatar: { uri: out.uri, base64, bytes: base64Bytes(base64) } };
        }
      }
    } finally {
      outRef.release();
    }
    return { ok: false, reason: 'too-heavy' };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}
