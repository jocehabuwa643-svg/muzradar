import type { Track } from '@muzradar/shared';

function whole(sec: number): number {
  return Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
}

/** 83 → «1:23», 3725 → «1:02:05». */
export function formatTime(sec: number): string {
  const s = whole(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/** Для экранного диктора: «1 мин 23 с» читается лучше, чем «один двоеточие двадцать три». */
export function formatSpokenTime(sec: number): string {
  const s = whole(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0) parts.push(`${m} мин`);
  if (s % 60 > 0 || parts.length === 0) parts.push(`${s % 60} с`);
  return parts.join(' ');
}

export function previewSeconds(track: Pick<Track, 'previewSec'>): number {
  return Math.round(track.previewSec ?? 30);
}

/** Подпись карточки для экранного диктора. */
export function trackA11yLabel(track: Track): string {
  const preview = track.playback === 'preview' ? `, отрывок ${previewSeconds(track)} секунд` : '';
  return `${track.title}, ${track.artist}${preview}`;
}
