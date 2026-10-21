import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { useSession } from '@/state/session';

// Гейт только про разрешение и службы: координаты здесь не читаются никогда.
export type LocationGateState = 'checking' | 'ok' | 'ok_approx' | 'services_off' | 'undetermined' | 'denied_can_ask' | 'blocked';

/** Текущее состояние без побочных эффектов. */
export async function readLocationGate(): Promise<Exclude<LocationGateState, 'checking'>> {
  if (!(await Location.hasServicesEnabledAsync())) return 'services_off';
  const p = await Location.getForegroundPermissionsAsync();
  if (p.granted) {
    // Android 12+ и iOS 14+ позволяют выдать только приблизительную геолокацию — это не отказ
    const approx = p.android?.accuracy === 'coarse' || p.ios?.accuracy === 'reduced';
    return approx ? 'ok_approx' : 'ok';
  }
  if (p.status === Location.PermissionStatus.UNDETERMINED) return 'undetermined';
  return p.canAskAgain ? 'denied_can_ask' : 'blocked';
}

/** Действие для исправления состояния: запрос разрешения, включение служб, переход в настройки. */
export async function resolveLocationGate(state: LocationGateState): Promise<void> {
  switch (state) {
    case 'undetermined':
    case 'denied_can_ask':
      // Только «При использовании»: фоновое разрешение не запрашивается никогда
      await Location.requestForegroundPermissionsAsync();
      return;
    case 'blocked':
      await Linking.openSettings();
      return;
    case 'services_off':
      if (Platform.OS === 'android') {
        try {
          // системный диалог Google Play Services; отклоняется при отказе и на телефонах без GMS
          await Location.enableNetworkProviderAsync();
        } catch {
          await openAndroidLocationSettings();
        }
      } else {
        // у iOS нет публичной ссылки на «Службы геолокации» — экран показывает инструкцию
        await Linking.openSettings();
      }
      return;
    default:
      return;
  }
}

async function openAndroidLocationSettings(): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.LOCATION_SOURCE_SETTINGS);
  } catch {
    await Linking.openSettings();
  }
}

/**
 * Мягкое предложение точной геолокации, если выдана приблизительная.
 * Android 12+ показывает системный диалог повышения точности; в iOS это меняется только в Настройках.
 */
export async function requestPreciseLocation(): Promise<void> {
  try {
    if (Platform.OS === 'android') await Location.requestForegroundPermissionsAsync();
    else await Linking.openSettings();
  } catch (err) {
    console.warn('[location] precise request failed', err);
  }
  await recheckShared();
}

// ─── общее состояние для всех подписчиков ────────────────────────────────────
// Гейт читают корневой экран-блокировка, шаги онбординга и карта: одно состояние на всех,
// чтобы экраны не расходились во мнении, есть ли доступ.

let current: LocationGateState = 'checking';
let generation = 0;
let resolving: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => current;

function publish(next: LocationGateState) {
  if (next !== current) {
    current = next;
    for (const l of listeners) l();
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
    // Сбой чтения не должен блокировать того, у кого доступ уже был;
    // а при первом чтении нужна кнопка, которой можно повторить запрос.
    next = current === 'checking' ? 'undetermined' : current;
  }
  // Пока шло чтение, мог стартовать более свежий запрос (возврат из настроек) — побеждает он
  if (gen !== generation) return;
  publish(next);
}

function resolveShared(): Promise<void> {
  // двойной тап не должен открывать два системных диалога
  resolving ??= (async () => {
    try {
      await resolveLocationGate(current);
    } catch (err) {
      console.warn('[location] gate resolve failed', err);
    }
    await recheckShared();
  })().finally(() => {
    resolving = null;
  });
  return resolving;
}

/**
 * Хук: перепроверяет гейт при монтировании и каждом возврате приложения на экран,
 * синхронизирует useSession.setLocation. `ok` — можно показывать карту.
 */
export function useLocationGate(): { state: LocationGateState; ok: boolean; approx: boolean; recheck: () => Promise<void>; resolve: () => Promise<void> } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void recheckShared();
    // возврат из Настроек; iOS «Разрешить один раз» истекает молча
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void recheckShared();
    });
    return () => sub.remove();
  }, []);

  return {
    state,
    ok: state === 'ok' || state === 'ok_approx',
    approx: state === 'ok_approx',
    recheck: recheckShared,
    resolve: resolveShared,
  };
}
