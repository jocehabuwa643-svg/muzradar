jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } } }));

import { appConfig, resolveWebApiUrl } from '../config.web';
import { forgetInstallSecret, getDeviceHint, getInstallSecret } from '../identity.web';
import { mmkvStateStorage } from '../storage.web';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
});

describe('web platform', () => {
  it('uses the current origin unless a public API URL is explicit', () => {
    expect(resolveWebApiUrl('https://radar.test/', undefined)).toBe('https://api.test');
    expect(resolveWebApiUrl('https://radar.test', 'https://api.test/')).toBe('https://api.test');
    expect(appConfig.apiUrl).toBe('https://api.test');
    expect(appConfig.locationGate).toBe('hard');
    expect(appConfig.liveLocation).toBe(false);
  });

  it('prefixes public assets for project Pages and root hosting', () => {
    const { assetUrl } = require('../config.web') as typeof import('../config.web');
    expect(assetUrl('/muzradar/', '/sw.js')).toBe('/muzradar/sw.js');
    expect(assetUrl('', '/sw.js')).toBe('/sw.js');
    expect(assetUrl(undefined, '/sw.js')).toBe('/sw.js');
  });

  it('persists session values through the StateStorage contract', () => {
    mmkvStateStorage.setItem('session-v1', '{"state":{"onboardedAt":"now"}}');
    expect(mmkvStateStorage.getItem('session-v1')).toBe('{"state":{"onboardedAt":"now"}}');
    mmkvStateStorage.removeItem('session-v1');
    expect(mmkvStateStorage.getItem('session-v1')).toBeNull();
  });

  it('creates one stable 43-char install secret and has no Android hint', async () => {
    const first = await getInstallSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getInstallSecret()).toBe(first);
    expect(getDeviceHint()).toBeUndefined();
    await forgetInstallSecret();
    expect(await getInstallSecret()).not.toBe(first);
  });
});
