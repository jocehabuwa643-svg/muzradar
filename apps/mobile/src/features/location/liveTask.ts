// КОНТРАКТ Live-режима (фаза 2, флаг LIVE_LOCATION). Модуль импортируется в корневом layout,
// чтобы TaskManager.defineTask выполнился в глобальной области до любой фоновой доставки.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState } from 'react-native';
import { getNowPlaying } from '@/features/player';
import { getFixState, setFixState } from '@/features/presence/cell';
import { applyFix, buildPresenceUpdate } from '@/features/presence/logic';
import { api } from '@/lib/api';
import { appConfig } from '@/lib/config';
import { useSession } from '@/state/session';

export const LIVE_LOCATION_TASK = 'muzradar.live-location';

interface LiveTaskData {
  locations?: Location.LocationObject[];
}

/**
 * Фоновая доставка фиксов. Координаты превращаются в ячейку здесь же и дальше не уходят;
 * на сервер — только ячейка и только пока играет музыка (так обещает уведомление).
 */
export async function handleLiveLocations(data: LiveTaskData | null | undefined): Promise<void> {
  const last = data?.locations?.at(-1);
  if (!last) return;
  const { next, changed } = applyFix(getFixState(), last.coords, useSession.getState().locationApprox);
  setFixState(next);
  const np = getNowPlaying();
  if (!changed || !next.cell || !np.playing || useSession.getState().onboardedAt === null) return;
  try {
    await api.presenceUpdate(buildPresenceUpdate(next.cell, next.motion, next.approx ?? false, np));
  } catch {
    // Сеть в фоне ненадёжна: следующий фикс или heartbeat догонят состояние
  }
}

if (appConfig.liveLocation) {
  TaskManager.defineTask<LiveTaskData>(LIVE_LOCATION_TASK, async ({ data, error }) => {
    if (error) {
      console.warn('[live] task error', error.message);
      return;
    }
    await handleLiveLocations(data);
  });
}

/** Запускать только когда приложение на экране (иначе Android бросит ForegroundServiceStartNotAllowedException). */
export async function startLiveLocation(): Promise<void> {
  if (!appConfig.liveLocation) return;
  if (AppState.currentState !== 'active') return;
  if (await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(LIVE_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 50,
    timeInterval: 30_000,
    deferredUpdatesInterval: 30_000,
    // В iOS нативное умолчание — true вопреки типам: без явного false обновления замирают на месте
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    // Foreground service — то, что избавляет от ACCESS_BACKGROUND_LOCATION на Android
    foregroundService: {
      notificationTitle: 'МУЗРАДАР',
      notificationBody: 'Вы видны на карте, пока играет музыка',
      notificationColor: '#C8FF3D',
      killServiceOnDestroy: true,
    },
  });
}

export async function stopLiveLocation(): Promise<void> {
  if (!appConfig.liveLocation) return;
  if (await isLiveLocationRunning()) await Location.stopLocationUpdatesAsync(LIVE_LOCATION_TASK);
}

export async function isLiveLocationRunning(): Promise<boolean> {
  if (!appConfig.liveLocation) return false;
  try {
    return await Location.hasStartedLocationUpdatesAsync(LIVE_LOCATION_TASK);
  } catch {
    return false;
  }
}
