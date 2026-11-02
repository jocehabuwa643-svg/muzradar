import { useEffect, useSyncExternalStore } from 'react';
import { useSession } from '@/state/session';

export type LocationGateState = 'checking' | 'ok' | 'ok_approx' | 'services_off' | 'undetermined' | 'denied_can_ask' | 'blocked';

let lastAccuracy: number | null = null;

export const approxFromAccuracy = (accuracyM: number | null | undefined) => (accuracyM ?? 0) > 500;

export function permissionToGate(state: PermissionState | 'unsupported'): Exclude<LocationGateState, 'checking'> {
  if (state === 'unsupported' || state === 'denied') return 'blocked';
  if (state === 'prompt') return 'undetermined';
  return approxFromAccuracy(lastAccuracy) ? 'ok_approx' : 'ok';
}

export function positionErrorGate(code: number): LocationGateState {
  if (code === 1) return 'blocked';
  if (code === 2) return 'services_off';
  return 'denied_can_ask';
}

export async function readLocationGate(): Promise<Exclude<LocationGateState, 'checking'>> {
  if (!globalThis.navigator?.geolocation) return 'blocked';
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (permission) return permissionToGate(permission.state);
  } catch {
    // Permissions API is optional; a user gesture can still request a fix below.
  }
  return lastAccuracy === null ? 'undetermined' : approxFromAccuracy(lastAccuracy) ? 'ok_approx' : 'ok';
}

function getPosition(enableHighAccuracy: boolean): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy, timeout: 15_000, maximumAge: 30_000 });
  });
}

export async function resolveLocationGate(_state: LocationGateState): Promise<void> {
  const position = await getPosition(true);
  lastAccuracy = position.coords.accuracy;
}

export async function requestPreciseLocation(): Promise<void> {
  try {
    await resolveLocationGate('ok_approx');
  } catch (err) {
    console.warn('[location] precise request failed', err);
  }
  await recheckShared();
}

let current: LocationGateState = 'checking';
let generation = 0;
let resolving: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;

function publish(next: LocationGateState) {
  if (next !== current) {
    current = next;
    for (const listener of listeners) listener();
  }
  if (next === 'checking') return;
  const ok = next === 'ok' || next === 'ok_approx';
  useSession.getState().setLocation(ok, next === 'ok_approx');
}

async function recheckShared(): Promise<void> {
  const gen = ++generation;
  let next: LocationGateState;
  try {
    next = await readLocationGate();
  } catch (err) {
    console.warn('[location] gate read failed', err);
    next = current === 'checking' ? 'undetermined' : current;
  }
  if (gen === generation) publish(next);
}

function resolveShared(): Promise<void> {
  resolving ??= (async () => {
    try {
      await resolveLocationGate(current);
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? Number(err.code) : 3;
      publish(positionErrorGate(code));
    }
    await recheckShared();
  })().finally(() => {
    resolving = null;
  });
  return resolving;
}

export function useLocationGate(): { state: LocationGateState; ok: boolean; approx: boolean; recheck: () => Promise<void>; resolve: () => Promise<void> } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void recheckShared();
    const recheck = () => void recheckShared();
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, []);
  return { state, ok: state === 'ok' || state === 'ok_approx', approx: state === 'ok_approx', recheck: recheckShared, resolve: resolveShared };
}
