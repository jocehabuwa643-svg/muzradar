import { LIMITS } from '@muzradar/shared';
import { base64Bytes, buildAvatar, cleanBase64 } from '../avatarPipeline';
import type { DetectedFace } from '../faceCheck';
import type { FaceDetector } from '../faceDetector';

// Фейковый ImageManipulator: записывает цепочку операций и отдаёт заранее заданные результаты сохранения.
type Op = { op: string; arg?: unknown };
type Saved = { uri: string; width: number; height: number; base64?: string };

const mockCalls: { source: string; ops: Op[]; saves: unknown[] }[] = [];
const mockReleased: string[] = [];
let mockSaveQueue: Saved[] = [];

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  ImageManipulator: {
    manipulate: (source: string) => {
      const record = { source, ops: [] as Op[], saves: [] as unknown[] };
      mockCalls.push(record);
      const ctx = {
        resize: (arg: unknown) => (record.ops.push({ op: 'resize', arg }), ctx),
        crop: (arg: unknown) => (record.ops.push({ op: 'crop', arg }), ctx),
        release: () => mockReleased.push(`ctx:${source}`),
        renderAsync: async () => ({
          release: () => mockReleased.push(`ref:${source}`),
          saveAsync: async (opts: unknown) => {
            record.saves.push(opts);
            const next = mockSaveQueue.shift();
            if (!next) throw new Error('нет заготовленного результата');
            return next;
          },
        }),
      };
      return ctx;
    },
  },
}));

const NORM: Saved = { uri: 'file:///norm.jpg', width: 720, height: 960 };
const goodFace: DetectedFace = {
  frame: { origin: { x: 210, y: 216 }, size: { x: 300, y: 360 } },
  hasHeadEulerAngleY: true,
  headEulerAngleY: 3,
  hasHeadEulerAngleZ: true,
  headEulerAngleZ: -2,
};

const detectorReturning = (faces: DetectedFace[] | Error): FaceDetector & { detect: jest.Mock } => ({
  detect: jest.fn(async () => {
    if (faces instanceof Error) throw faces;
    return faces;
  }),
});

beforeEach(() => {
  mockCalls.length = 0;
  mockReleased.length = 0;
  mockSaveQueue = [];
});

test('полный путь: 720 px JPEG → детекция → квадрат по лицу → 128×128 WebP q0.6 с base64', async () => {
  mockSaveQueue = [NORM, { uri: 'file:///avatar.webp', width: 128, height: 128, base64: 'QUJD\nREVG' }];
  const detector = detectorReturning([goodFace]);

  const r = await buildAvatar('file:///shot.jpg', detector);

  expect(r).toEqual({ ok: true, avatar: { uri: 'file:///avatar.webp', base64: 'QUJDREVG', bytes: 6 } });
  expect(mockCalls[0]).toEqual({ source: 'file:///shot.jpg', ops: [{ op: 'resize', arg: { width: 720 } }], saves: [{ format: 'jpeg', compress: 0.9 }] });
  // детекция и кроп — по одному и тому же нормализованному файлу
  expect(detector.detect).toHaveBeenCalledWith('file:///norm.jpg');
  expect(mockCalls[1]!.source).toBe('file:///norm.jpg');
  expect(mockCalls[1]!.ops).toEqual([
    { op: 'crop', arg: { originX: 54, originY: 61, width: 612, height: 612 } },
    { op: 'resize', arg: { width: LIMITS.avatarSide, height: LIMITS.avatarSide } },
  ]);
  expect(mockCalls[1]!.saves).toEqual([{ format: 'webp', compress: 0.6, base64: true }]);
  // нативные объекты освобождаются, а не ждут сборщика мусора
  expect(mockReleased.sort()).toEqual(['ctx:file:///norm.jpg', 'ctx:file:///shot.jpg', 'ref:file:///norm.jpg', 'ref:file:///shot.jpg']);
});

test.each<[string, DetectedFace[], string]>([
  ['нет лица', [], 'none'],
  ['два лица', [goodFace, goodFace], 'many'],
  ['голова повёрнута', [{ ...goodFace, headEulerAngleY: 35 }], 'turned'],
])('%s → отказ «%s» без кропа', async (_name, faces, reason) => {
  mockSaveQueue = [NORM];
  const r = await buildAvatar('file:///shot.jpg', detectorReturning(faces));
  expect(r).toEqual({ ok: false, reason });
  expect(mockCalls).toHaveLength(1);
});

test('тяжёлый снимок пережимается сильнее, пока не влезет в лимит', async () => {
  const heavy = 'A'.repeat(LIMITS.avatarBase64Max + 4);
  mockSaveQueue = [
    NORM,
    { uri: 'file:///a1.webp', width: 128, height: 128, base64: heavy },
    { uri: 'file:///a2.webp', width: 128, height: 128, base64: 'QUJDRA==' },
  ];
  const r = await buildAvatar('file:///shot.jpg', detectorReturning([goodFace]));
  expect(r).toEqual({ ok: true, avatar: { uri: 'file:///a2.webp', base64: 'QUJDRA==', bytes: 4 } });
  expect(mockCalls[1]!.saves).toEqual([
    { format: 'webp', compress: 0.6, base64: true },
    { format: 'webp', compress: 0.45, base64: true },
  ]);
});

test('не влез даже на минимальном качестве → too-heavy', async () => {
  const heavy = { uri: 'file:///a.webp', width: 128, height: 128, base64: 'A'.repeat(LIMITS.avatarBase64Max + 1) };
  mockSaveQueue = [NORM, heavy, heavy, heavy];
  const r = await buildAvatar('file:///shot.jpg', detectorReturning([goodFace]));
  expect(r).toEqual({ ok: false, reason: 'too-heavy' });
});

test('сбой детектора — это failed, а не «лица нет»', async () => {
  mockSaveQueue = [NORM];
  const r = await buildAvatar('file:///shot.jpg', detectorReturning(new Error('ML Kit недоступен')));
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toBe('failed');
});

test('пустой base64 от saveAsync — failed', async () => {
  mockSaveQueue = [NORM, { uri: 'file:///a.webp', width: 128, height: 128 }];
  const r = await buildAvatar('file:///shot.jpg', detectorReturning([goodFace]));
  expect(!r.ok && r.reason).toBe('failed');
});

test('base64: чистка префикса и переносов, подсчёт байтов', () => {
  expect(cleanBase64('data:image/webp;base64,QU JD\r\nRA==')).toBe('QUJDRA==');
  expect(cleanBase64(undefined)).toBe('');
  expect(base64Bytes('QUJD')).toBe(3);
  expect(base64Bytes('QUI=')).toBe(2);
  expect(base64Bytes('QQ==')).toBe(1);
});
