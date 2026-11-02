/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'Vision', {
  configurable: true,
  value: {
    FilesetResolver: { forVisionTasks: jest.fn(async () => ({})) },
    FaceLandmarker: {
      createFromOptions: jest.fn(async () => ({
        detect: jest.fn(() => ({ faceLandmarks: [], facialTransformationMatrixes: [] })),
      })),
    },
  },
});

import { base64Bytes, canvasToWebpDataUrl, cleanBase64, resizeAndCrop } from '../avatarPipeline.web';
import { matrixEulerAngles, mlkitFaceDetector, warmUpFaceDetector } from '../faceDetector.web';

it('loads the web face-detection boundary without the native ML Kit module', () => {
  expect(() => warmUpFaceDetector()).not.toThrow();
});

it('normalizes to 720px and crops the final avatar to 128×128', () => {
  const context = { drawImage: jest.fn() };
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const source = { width: 1440, height: 720 } as unknown as HTMLImageElement;

  const normalized = resizeAndCrop(source, null);
  expect(normalized.width).toBe(720);
  expect(normalized.height).toBe(360);
  expect(context.drawImage).toHaveBeenLastCalledWith(source, 0, 0, 720, 360);

  const cropped = resizeAndCrop(source, { originX: 10, originY: 20, width: 300, height: 300 });
  expect(cropped.width).toBe(128);
  expect(cropped.height).toBe(128);
  expect(context.drawImage).toHaveBeenLastCalledWith(source, 10, 20, 300, 300, 0, 0, 128, 128);
});

it('encodes WebP and measures clean base64', () => {
  const canvas = document.createElement('canvas');
  const toDataURL = jest.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/webp;base64,QUJD');
  expect(canvasToWebpDataUrl(canvas, 0.6)).toBe('data:image/webp;base64,QUJD');
  expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.6);
  expect(cleanBase64('data:image/webp;base64,QUJD\n')).toBe('QUJD');
  expect(base64Bytes('QUJD')).toBe(3);
});

it('extracts frontal-check yaw and roll from the transformation matrix', () => {
  expect(matrixEulerAngles([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toEqual({ yaw: 0, roll: 0 });
  const roll = (10 * Math.PI) / 180;
  const rolled = matrixEulerAngles([Math.cos(roll), Math.sin(roll), 0, 0, -Math.sin(roll), Math.cos(roll), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  expect(rolled.roll).toBeCloseTo(10);
  const yaw = (15 * Math.PI) / 180;
  const turned = matrixEulerAngles([Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, 0, 0, 0, 1]);
  expect(turned.yaw).toBeCloseTo(15);
});

it('converts normalized landmarks to a pixel face frame with angles', () => {
  const { landmarksToFace } = require('../faceDetector.web') as typeof import('../faceDetector.web');
  const face = landmarksToFace(
    [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.6 }],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    1000,
    600,
  );
  expect(face.frame).toEqual({ origin: { x: 200, y: 180 }, size: { x: 200, y: 180 } });
  expect(face.hasHeadEulerAngleY).toBe(true);
  expect(face.hasHeadEulerAngleZ).toBe(true);
});

it('returns no faces through the same FaceDetector contract', async () => {
  const originalImage = globalThis.Image;
  class LoadedImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 720;
    naturalHeight = 360;
    crossOrigin: string | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, 'Image', { value: LoadedImage, configurable: true });
  try {
    await expect(mlkitFaceDetector.detect('data:image/jpeg;base64,QUJD')).resolves.toEqual([]);
  } finally {
    Object.defineProperty(globalThis, 'Image', { value: originalImage, configurable: true });
  }
});

it('crops the avatar from the same normalized frame used for detection', async () => {
  const { buildAvatar } = require('../avatarPipeline.web') as typeof import('../avatarPipeline.web');
  const originalImage = globalThis.Image;
  class LoadedImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1440;
    naturalHeight = 720;
    width = 1440;
    height = 720;
    crossOrigin: string | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, 'Image', { value: LoadedImage, configurable: true });
  const context = { drawImage: jest.fn() };
  const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const toDataURL = jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/webp;base64,QUJD');
  const detector = {
    detect: jest.fn(async () => [{
      frame: { origin: { x: 180, y: 90 }, size: { x: 360, y: 180 } },
      hasHeadEulerAngleY: true,
      headEulerAngleY: 0,
      hasHeadEulerAngleZ: true,
      headEulerAngleZ: 0,
    }]),
  };
  try {
    const result = await buildAvatar('data:image/jpeg;base64,QUJD', detector);
    expect(result.ok).toBe(true);
    const cropSource = context.drawImage.mock.calls[1]?.[0];
    expect(cropSource).toBeInstanceOf(HTMLCanvasElement);
  } finally {
    getContext.mockRestore();
    toDataURL.mockRestore();
    Object.defineProperty(globalThis, 'Image', { value: originalImage, configurable: true });
  }
});
