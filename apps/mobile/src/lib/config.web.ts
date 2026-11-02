import Constants from 'expo-constants';

interface Extra {
  locationGate?: string;
  appVariant?: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

export function resolveWebApiUrl(origin: string | undefined, explicit = process.env.EXPO_PUBLIC_API_URL): string {
  return (explicit?.trim() || origin || 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

export const appConfig = {
  apiUrl: resolveWebApiUrl(globalThis.location?.origin),
  locationGate: (extra.locationGate === 'map-only' ? 'map-only' : 'hard') as 'hard' | 'map-only',
  liveLocation: false,
  appVariant: extra.appVariant ?? 'development',
  appVersion: Constants.expoConfig?.version ?? '0.0.0',
} as const;

export function absoluteUrl(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${appConfig.apiUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}
