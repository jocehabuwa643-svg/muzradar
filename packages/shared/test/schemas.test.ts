import { describe, expect, it } from 'vitest';
import { LEGAL_VERSIONS } from '../src/constants.ts';
import {
  ConsentsInput,
  DeviceAuthRequest,
  DisplayName,
  PresenceUpdate,
  ProfileInput,
  TrackId,
  ViewportQuery,
} from '../src/schemas.ts';

const now = new Date().toISOString();

describe('DisplayName', () => {
  it('accepts cyrillic and latin names', () => {
    expect(DisplayName.parse('  Маша  ')).toBe('Маша');
    expect(DisplayName.parse('dj_nik.2')).toBe('dj_nik.2');
  });
  it('rejects links, emoji-only and too short names', () => {
    expect(DisplayName.safeParse('go to site.ru').success).toBe(false);
    expect(DisplayName.safeParse('https://x').success).toBe(false);
    expect(DisplayName.safeParse('🔥🔥').success).toBe(false);
    expect(DisplayName.safeParse('a').success).toBe(false);
    expect(DisplayName.safeParse('_leading').success).toBe(false);
  });
});

describe('DeviceAuthRequest', () => {
  const ok = { installSecret: 'A'.repeat(43), platform: 'android', appVersion: '1.0.0', deviceHint: 'a1b2c3d4e5f60718' };
  it('requires a 43-char base64url secret', () => {
    expect(DeviceAuthRequest.safeParse(ok).success).toBe(true);
    expect(DeviceAuthRequest.safeParse({ ...ok, installSecret: 'short' }).success).toBe(false);
  });
  it('never accepts an IP as a device hint', () => {
    expect(DeviceAuthRequest.safeParse({ ...ok, deviceHint: '192.168.0.1' }).success).toBe(false);
  });
  it('accepts a browser without a device hint', () => {
    expect(DeviceAuthRequest.safeParse({ installSecret: 'A'.repeat(43), platform: 'web', appVersion: '1.0.0' }).success).toBe(true);
  });
});

describe('ConsentsInput', () => {
  const consents = {
    processing: { version: LEGAL_VERSIONS.processing, acceptedAt: now },
    dissemination: { version: LEGAL_VERSIONS.dissemination, acceptedAt: now, scope: ['name', 'avatar', 'track', 'location'] },
    rules: { version: LEGAL_VERSIONS.rules, acceptedAt: now },
  };
  it('accepts full consents', () => {
    expect(ConsentsInput.safeParse({ birthYear: 2000, consents }).success).toBe(true);
  });
  it('requires a non-empty dissemination scope', () => {
    const bad = { ...consents, dissemination: { ...consents.dissemination, scope: [] } };
    expect(ConsentsInput.safeParse({ birthYear: 2000, consents: bad }).success).toBe(false);
  });
});

describe('ProfileInput', () => {
  const base = {
    name: 'Маша',
    taste: { genres: ['pop', 'rock', 'indie'], moods: ['night'], artists: ['Земфира'] },
  };
  it('accepts a complete profile', () => {
    expect(ProfileInput.safeParse(base).success).toBe(true);
  });
  it('enforces taste minimums and known ids', () => {
    expect(ProfileInput.safeParse({ ...base, taste: { ...base.taste, genres: ['pop'] } }).success).toBe(false);
    expect(ProfileInput.safeParse({ ...base, taste: { ...base.taste, moods: [] } }).success).toBe(false);
    expect(ProfileInput.safeParse({ ...base, taste: { ...base.taste, artists: [] } }).success).toBe(false);
    expect(ProfileInput.safeParse({ ...base, taste: { ...base.taste, genres: ['pop', 'rock', 'polka'] } }).success).toBe(false);
  });
});

describe('PresenceUpdate', () => {
  const upd = { cell: 'ucfv0nr', motion: 'walk', approx: false, track: null, playing: false, positionSec: null };
  it('accepts a precision-7 cell only', () => {
    expect(PresenceUpdate.safeParse(upd).success).toBe(true);
    expect(PresenceUpdate.safeParse({ ...upd, cell: 'ucfv0nrx' }).success).toBe(false);
    expect(PresenceUpdate.safeParse({ ...upd, cell: 'ucfv0' }).success).toBe(false);
  });
  it('drops raw coordinates if a client sends them', () => {
    const parsed = PresenceUpdate.parse({ ...upd, lat: 55.75, lng: 37.61 });
    expect(parsed).not.toHaveProperty('lat');
    expect(parsed).not.toHaveProperty('lng');
  });
});

describe('ViewportQuery', () => {
  it('parses a bbox string', () => {
    expect(ViewportQuery.parse({ bbox: '37.5,55.7,37.7,55.8', zoom: '13' })).toEqual({
      bbox: [37.5, 55.7, 37.7, 55.8],
      zoom: 13,
    });
  });
  it('rejects inverted or malformed boxes', () => {
    expect(ViewportQuery.safeParse({ bbox: '37.7,55.7,37.5,55.8', zoom: 13 }).success).toBe(false);
    expect(ViewportQuery.safeParse({ bbox: '1,2,3', zoom: 13 }).success).toBe(false);
  });
});

describe('TrackId', () => {
  it('is provider-prefixed', () => {
    expect(TrackId.safeParse('audius:D7KyD').success).toBe(true);
    expect(TrackId.safeParse('archive:item/file.mp3').success).toBe(true);
    expect(TrackId.safeParse('no-prefix').success).toBe(false);
  });
});
