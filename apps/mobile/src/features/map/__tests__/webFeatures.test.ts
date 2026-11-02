/** @jest-environment jsdom */
import type { PresenceView } from '@muzradar/shared';
import { listenerShape, zonesToFeatures } from '../features';
import { createListenerElement } from '../webFeatures';

const view: PresenceView = {
  userId: 'u_abcdefghijklmnopqrst',
  name: 'Маша',
  mapAvatarUrl: '/avatar.webp',
  lng: 37.61,
  lat: 55.75,
  precision: 6,
  approx: false,
  motion: 'still',
  track: { id: 'audius:abc', title: 'Ночь', artist: 'Кино', artworkUrl: null, playback: 'full' },
  playing: true,
  positionSec: 10,
  updatedAt: 1,
};

it('creates a real button with avatar and current track', () => {
  const onSelect = jest.fn();
  const element = createListenerElement(view, onSelect);
  expect(element.tagName).toBe('BUTTON');
  expect(element.textContent).toContain('Ночь');
  expect(element.getAttribute('aria-label')).toContain('Маша');
  expect(element.querySelector('img')?.getAttribute('src')).toContain('/avatar.webp');
  element.click();
  expect(onSelect).toHaveBeenCalledWith(view.userId);
});

it('keeps approx listeners as a zone, not a precise pin', () => {
  const approx = { ...view, approx: true };
  expect(listenerShape(approx).kind).toBe('zone');
  expect(zonesToFeatures([approx]).features).toHaveLength(1);
});

it('centers on the first device fix only when no previous map view exists', () => {
  const { shouldCenterOnFirstFix } = require('../webFeatures') as typeof import('../webFeatures');
  expect(shouldCenterOnFirstFix(null, false)).toBe(true);
  expect(shouldCenterOnFirstFix({ center: [37, 55], zoom: 14 }, false)).toBe(false);
  expect(shouldCenterOnFirstFix(null, true)).toBe(false);
});
