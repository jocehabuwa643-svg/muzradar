import Constants from 'expo-constants';

interface Extra {
  apiUrl?: string;
  locationGate?: string;
  liveLocation?: boolean;
  appVariant?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export const appConfig = {
  apiUrl: (extra.apiUrl ?? 'http://10.0.2.2:8080').replace(/\/+$/, ''),
  /** hard — без геолокации блокируется всё; map-only — только карта. */
  locationGate: (extra.locationGate === 'map-only' ? 'map-only' : 'hard') as 'hard' | 'map-only',
  liveLocation: extra.liveLocation === true,
  appVariant: extra.appVariant ?? 'development',
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
} as const;

/** Сервер отдаёт ссылки на свои файлы относительными — дополняем адресом API. */
export function absoluteUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${appConfig.apiUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}
