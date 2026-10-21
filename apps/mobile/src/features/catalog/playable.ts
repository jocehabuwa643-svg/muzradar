import type { ProviderId, Track } from '@muzradar/shared';

/**
 * Эти источники никогда не звучат в приложении: условия Deezer запрещают публичные
 * приложения, а превью iTunes — только промо-карточка, не для очереди и фона.
 * Сервер их и так не отдаёт в плеер; проверка здесь — вторая линия обороны.
 */
export const NEVER_PLAYED_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['deezer', 'itunes']);

/** Трек можно показывать в витрине и ставить в очередь. */
export function canList(track: Track): boolean {
  return track.playback !== 'unavailable' && !NEVER_PLAYED_PROVIDERS.has(track.provider);
}

/** Трек можно отдать плееру прямо сейчас: разрешён и есть ссылка на поток. */
export function canStream(track: Track): boolean {
  return canList(track) && Boolean(track.streamUrl);
}

/** Длина того, что реально прозвучит: у превью — отрывок, а не весь трек. */
export function audibleDurationSec(track: Track): number {
  if (track.playback === 'preview') return track.previewSec ?? Math.min(30, track.durationSec || 30);
  return track.durationSec;
}

/** Есть ли что играть после позиции `index` в порядке воспроизведения. */
export function hasStreamableAfter(queue: readonly Track[], index: number): boolean {
  if (index < 0) return false;
  for (let i = index + 1; i < queue.length; i++) {
    const t = queue[i];
    if (t && canStream(t)) return true;
  }
  return false;
}
