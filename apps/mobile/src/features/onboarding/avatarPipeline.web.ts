import { LIMITS } from '@muzradar/shared';
import { checkFaces, faceSquare, type CropRect, type FaceVerdict } from './faceCheck';
import { mlkitFaceDetector, type FaceDetector } from './faceDetector.web';

export interface AvatarImage {
  uri: string;
  base64: string;
  bytes: number;
}

export type AvatarFailure = Exclude<FaceVerdict, 'ok'> | 'too-heavy' | 'failed';
export type AvatarResult = { ok: true; avatar: AvatarImage } | { ok: false; reason: AvatarFailure; error?: unknown };

const NORMALIZED_WIDTH = 720;
const WEBP_QUALITY_STEPS = [0.6, 0.45, 0.3] as const;

export const AVATAR_FAILURE_MESSAGES: Record<'too-heavy' | 'failed', { title: string; hint: string }> = {
  'too-heavy': { title: 'Снимок получился слишком тяжёлым', hint: 'Переснимите при ровном свете.' },
  failed: { title: 'Не получилось обработать снимок', hint: 'Попробуйте ещё раз.' },
};

export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function cleanBase64(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
}

export function resizeAndCrop(source: CanvasImageSource & { width: number; height: number }, box: CropRect | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const width = box ? LIMITS.avatarSide : NORMALIZED_WIDTH;
  const height = box ? LIMITS.avatarSide : Math.round((source.height / source.width) * NORMALIZED_WIDTH);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D недоступен');
  if (box) context.drawImage(source, box.originX, box.originY, box.width, box.height, 0, 0, width, height);
  else context.drawImage(source, 0, 0, width, height);
  return canvas;
}

export function canvasToWebpDataUrl(canvas: HTMLCanvasElement, quality: number): string {
  return canvas.toDataURL('image/webp', quality);
}

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/i.test(uri)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось прочитать снимок'));
    image.src = uri;
  });
}

export async function buildAvatar(photoUri: string, detector: FaceDetector = mlkitFaceDetector): Promise<AvatarResult> {
  try {
    const source = await loadImage(photoUri);
    const normalized = resizeAndCrop(source, null);
    const faces = await detector.detect(normalized.toDataURL('image/jpeg', 0.9));
    const verdict = checkFaces(faces, normalized.width, normalized.height);
    if (verdict !== 'ok') return { ok: false, reason: verdict };

    const box = faceSquare(faces[0]!.frame, normalized.width, normalized.height);
    if (box.width < 1) return { ok: false, reason: 'failed' };
    const cropped = resizeAndCrop(normalized, box);
    for (const quality of WEBP_QUALITY_STEPS) {
      const uri = canvasToWebpDataUrl(cropped, quality);
      const base64 = cleanBase64(uri);
      if (base64.length <= LIMITS.avatarBase64Max) return { ok: true, avatar: { uri, base64, bytes: base64Bytes(base64) } };
    }
    return { ok: false, reason: 'too-heavy' };
  } catch (error) {
    return { ok: false, reason: 'failed', error };
  }
}
