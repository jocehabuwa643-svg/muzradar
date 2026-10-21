import type { Track } from '@muzradar/shared';

export function makeTrack(n: number, over: Partial<Track> = {}): Track {
  return {
    id: `audius:t${n}`,
    provider: 'audius',
    title: `Трек ${n}`,
    artist: `Артист ${n}`,
    album: null,
    artworkUrl: `https://img.test/${n}.jpg`,
    durationSec: 200,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: `https://stream.test/${n}.mp3`,
    ...over,
  };
}

export const tracks = (...ns: number[]) => ns.map((n) => makeTrack(n));
