import { LIMITS } from '@muzradar/shared';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import { sha256Hex } from '../../ids.ts';
import { httpError } from '../../plugins/errors.ts';

export interface ProcessedAvatar {
  /** sha256 мастер-файла — адрес аватара. */
  hash: string;
  /** 128×128 WebP без альфы и метаданных. */
  webp: Buffer;
  /** 96×96 круглый WebP с прозрачными углами — маркер на карте. */
  mapWebp: Buffer;
}

const MAX_SIDE = 1024;

/** Клиент присылает 128×128; запас на старые сборки, но без декодирования фотографий в 12 Мп. */
const DECODE: SharpOptions = { failOn: 'error', limitInputPixels: MAX_SIDE * MAX_SIDE };

const MAP_SIDE = LIMITS.mapAvatarSide;
const CIRCLE_MASK = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_SIDE}" height="${MAP_SIDE}">` +
    `<circle cx="${MAP_SIDE / 2}" cy="${MAP_SIDE / 2}" r="${MAP_SIDE / 2}" fill="#fff"/></svg>`,
);

const badImage = () => httpError.unprocessable('bad_image', `Нужен снимок JPEG или WebP не больше ${MAX_SIDE}×${MAX_SIDE}`);

/**
 * Клиент мог быть модифицирован, поэтому файл пересобирается с нуля: EXIF (в том числе GPS),
 * ICC и XMP не переживают перекодирование — keepMetadata/withMetadata здесь не вызывать.
 */
export async function processAvatar(imageBase64: string): Promise<ProcessedAvatar> {
  const input = Buffer.from(imageBase64, 'base64');
  if (input.length === 0) throw badImage();

  let meta: Metadata;
  try {
    meta = await sharp(input, DECODE).metadata();
  } catch {
    throw badImage();
  }
  if (meta.format !== 'jpeg' && meta.format !== 'webp') throw badImage();
  if (!meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE) throw badImage();
  if ((meta.pages ?? 1) > 1) throw badImage();

  try {
    const side = LIMITS.avatarSide;
    const webp = await sharp(input, { ...DECODE, autoOrient: true })
      .removeAlpha()
      .resize(side, side, { fit: 'cover', position: 'centre' })
      .webp({ quality: 60, effort: 6, smartSubsample: true })
      .toBuffer();
    // Из мастера, а не из исходника: кроп и поворот гарантированно совпадают.
    const mapWebp = await sharp(webp, DECODE)
      .resize(MAP_SIDE, MAP_SIDE)
      .ensureAlpha()
      .composite([{ input: CIRCLE_MASK, blend: 'dest-in' }])
      .webp({ quality: 60, effort: 6, smartSubsample: true })
      .toBuffer();
    return { hash: sha256Hex(webp), webp, mapWebp };
  } catch {
    // Заголовок читается, а тело битое (обрезанный JPEG) — ошибка всплывает только при декодировании.
    throw badImage();
  }
}
