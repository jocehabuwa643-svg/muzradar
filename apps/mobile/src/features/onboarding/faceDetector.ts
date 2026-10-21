import { RNMLKitFaceDetector, type RNMLKitFaceDetectorOptions } from '@infinitered/react-native-mlkit-face-detection';
import type { DetectedFace } from './faceCheck';

/** Детектор лиц на снимке. Интерфейс — чтобы пайплайн тестировался без нативного ML Kit. */
export interface FaceDetector {
  /** Лица в пикселях изображения по `uri`. Бросает FaceDetectionError, если детектор не отработал. */
  detect(uri: string): Promise<DetectedFace[]>;
}

export class FaceDetectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceDetectionError';
  }
}

// minFaceSize 0.2: мелкие лица на фоне не должны валить правило «ровно одно лицо».
// Ориентиры, контуры и классификация не нужны — только рамка и углы головы.
const OPTIONS: RNMLKitFaceDetectorOptions = {
  performanceMode: 'accurate',
  minFaceSize: 0.2,
  landmarkMode: false,
  contourMode: false,
  classificationMode: false,
  isTrackingEnabled: false,
};

let shared: Promise<RNMLKitFaceDetector> | null = null;

function getDetector(): Promise<RNMLKitFaceDetector> {
  shared ??= (async () => {
    // Без deferInitialization конструктор запускает initialize() без await — первая детекция гоняется с загрузкой модели
    const detector = new RNMLKitFaceDetector(OPTIONS, true);
    await detector.initialize();
    // initialize() глотает нативные ошибки и лишь выставляет status
    if (detector.status === 'error') throw new FaceDetectionError('Модель распознавания лиц не загрузилась');
    return detector;
  })().catch((err: unknown) => {
    shared = null;
    throw err instanceof FaceDetectionError ? err : new FaceDetectionError(String(err));
  });
  return shared;
}

/** Загрузить модель заранее, пока человек выстраивает кадр. */
export function warmUpFaceDetector(): void {
  void getDetector().catch(() => undefined);
}

export const mlkitFaceDetector: FaceDetector = {
  async detect(uri) {
    const detector = await getDetector();
    const result = await detector.detectFaces(uri);
    // detectFaces() тоже глотает ошибки и возвращает undefined — это сбой, а не «лиц нет»
    if (!result || !result.success) throw new FaceDetectionError(result?.error ?? 'Детектор лиц не вернул результат');
    return result.faces;
  },
};
