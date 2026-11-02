import type { DetectedFace } from './faceCheck';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

interface LandmarkerResult {
  faceLandmarks: { x: number; y: number }[][];
  facialTransformationMatrixes: { data: number[] }[];
}

interface Landmarker {
  detect(image: HTMLImageElement): LandmarkerResult;
}

interface VisionApi {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> };
  FaceLandmarker: { createFromOptions(fileset: unknown, options: Record<string, unknown>): Promise<Landmarker> };
}

export function matrixEulerAngles(matrix: readonly number[]): { yaw: number; roll: number } {
  const deg = 180 / Math.PI;
  return {
    yaw: Math.atan2(-(matrix[2] ?? 0), matrix[0] ?? 1) * deg || 0,
    roll: Math.atan2(matrix[1] ?? 0, matrix[0] ?? 1) * deg || 0,
  };
}

export function landmarksToFace(
  landmarks: readonly { x: number; y: number }[],
  matrix: readonly number[],
  width: number,
  height: number,
): DetectedFace {
  const xs = landmarks.map((point) => point.x * width);
  const ys = landmarks.map((point) => point.y * height);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const angles = matrixEulerAngles(matrix);
  return {
    frame: { origin: { x: left, y: top }, size: { x: right - left, y: bottom - top } },
    hasHeadEulerAngleY: true,
    headEulerAngleY: angles.yaw,
    hasHeadEulerAngleZ: true,
    headEulerAngleZ: angles.roll,
  };
}

export interface FaceDetector {
  detect(uri: string): Promise<DetectedFace[]>;
}

export class FaceDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceDetectionError';
  }
}

let visionPromise: Promise<VisionApi> | null = null;

function loadVision(): Promise<VisionApi> {
  const existing = (globalThis as unknown as { Vision?: VisionApi }).Vision;
  if (existing) return Promise.resolve(existing);
  visionPromise ??= new Promise<VisionApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/vision_bundle.js';
    script.async = true;
    script.onload = () => {
      const api = (globalThis as unknown as { Vision?: VisionApi }).Vision;
      if (api) resolve(api);
      else reject(new FaceDetectionError('MediaPipe не зарегистрировал Vision API'));
    };
    script.onerror = () => reject(new FaceDetectionError('Не удалось загрузить MediaPipe'));
    document.head.append(script);
  }).catch((err: unknown) => {
    visionPromise = null;
    throw err;
  });
  return visionPromise;
}

let shared: Promise<Landmarker> | null = null;

function getDetector(): Promise<Landmarker> {
  shared ??= (async () => {
    const api = await loadVision();
    const vision = await api.FilesetResolver.forVisionTasks('/wasm');
    return api.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: '/models/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      outputFacialTransformationMatrixes: true,
    });
  })().catch((err: unknown) => {
    shared = null;
    throw err instanceof FaceDetectionError ? err : new FaceDetectionError(String(err));
  });
  return shared;
}

export function warmUpFaceDetector(): void {
  void getDetector().catch(() => undefined);
}

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:/i.test(uri)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new FaceDetectionError('Не удалось прочитать снимок'));
    image.src = uri;
  });
}

export const mlkitFaceDetector: FaceDetector = {
  async detect(uri) {
    try {
      const [image, detector] = await Promise.all([loadImage(uri), getDetector()]);
      const result = detector.detect(image);
      return result.faceLandmarks.map((landmarks, index) =>
        landmarksToFace(landmarks, result.facialTransformationMatrixes[index]?.data ?? IDENTITY, image.naturalWidth, image.naturalHeight),
      );
    } catch (error) {
      throw error instanceof FaceDetectionError ? error : new FaceDetectionError(String(error));
    }
  },
};
