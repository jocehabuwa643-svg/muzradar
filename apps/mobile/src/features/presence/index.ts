import { PRESENCE, type PresenceUpdate } from '@muzradar/shared';
import * as Location from 'expo-location';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { readLocationGate, useLocationGate } from '@/features/location/gate';
import { getNowPlaying, subscribeNowPlaying, useNowPlaying } from '@/features/player';
import { api } from '@/lib/api';
import { emitAck, getRealtime } from '@/lib/realtime';
import { useSession } from '@/state/session';
import { getFixState, resetFixState, setFixState } from './cell';
import {
  applyFix,
  backgroundBeat,
  buildHeartbeat,
  buildPresenceUpdate,
  LatestThrottle,
  playingKey,
  publishableFix,
  publisherMode,
  type GateMode,
} from './logic';

export { publisherMode, type PublisherMode } from './logic';

const subscribeAppState = (cb: () => void) => {
  const sub = AppState.addEventListener('change', cb);
  return () => sub.remove();
};
const appStateSnapshot = () => AppState.currentState;

const isOnboarded = () => useSession.getState().onboardedAt !== null;

/** Текущий режим разрешения; координат не читает. Любая ошибка — считаем, что геолокации нет. */
async function currentGateMode(): Promise<GateMode> {
  try {
    const state = await readLocationGate();
    if (state === 'ok') return 'precise';
    if (state === 'ok_approx') return 'approx';
    return 'lost';
  } catch {
    return 'lost';
  }
}

// Лимит сервера и обрыв связи — повод повторить; ошибку валидации повторять бессмысленно.
const RETRYABLE = /rate|limit|timed? ?out/i;

/**
 * Приложение на экране: наблюдение за позицией → ячейка с гистерезисом → presence:update по сокету.
 * Возвращает функцию остановки.
 */
function startWatching(): () => void {
  const socket = getRealtime();
  let stopped = false;
  let watcher: Location.LocationSubscription | null = null;

  const throttle = new LatestThrottle<PresenceUpdate>(PRESENCE.minIntervalMs, (update) => {
    // Без связи не буферизуем в сокете: socket.io отправил бы устаревшую пачку после переподключения.
    if (!socket.connected) return false;
    emitAck('presence:update', update).catch((err: unknown) => {
      if (err instanceof Error && RETRYABLE.test(err.message)) throttle.requeue(update);
    });
    return true;
  });

  // После возврата из настроек гейт перечитывает разрешение асинхронно, а в сессии ещё старый режим.
  // Пока режим не подтверждён, не отправляем ничего: чужой радар не должен мигнуть точной ячейкой
  // человеку, который только что выключил точную геопозицию.
  let modeConfirmed = false;

  const publish = () => {
    if (!modeConfirmed) return;
    const { cell, motion, approx } = publishableFix(getFixState(), useSession.getState().locationApprox);
    if (!cell) return;
    throttle.push(buildPresenceUpdate(cell, motion, approx, getNowPlaying()));
  };

  Location.watchPositionAsync(
    { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 10_000 },
    (loc) => {
      if (stopped) return;
      const { next, changed } = applyFix(getFixState(), loc.coords, useSession.getState().locationApprox);
      setFixState(next);
      if (changed) publish();
    },
    (reason) => console.warn('[presence] location watch error', reason),
  )
    .then((sub) => {
      if (stopped) sub.remove();
      else watcher = sub;
    })
    .catch((err: unknown) => console.warn('[presence] location watch failed', err));

  // Гейт перечитывает разрешение асинхронно после возврата из настроек: если точную геопозицию
  // выключили, переотправляем квартал сразу, не дожидаясь нового фикса.
  const unsubscribeSession = useSession.subscribe((s, prev) => {
    if (s.locationApprox === prev.locationApprox) return;
    modeConfirmed = true;
    publish();
  });

  void currentGateMode().then((mode) => {
    if (stopped) return;
    // Разрешение отозвали — гейт вот-вот остановит наблюдение; до этого молчим.
    if (mode === 'lost') return;
    useSession.getState().setLocation(true, mode === 'approx');
    modeConfirmed = true;
    publish();
  });

  let key = playingKey(getNowPlaying());
  const unsubscribePlayer = subscribeNowPlaying((np) => {
    const next = playingKey(np);
    if (next === key) return;
    key = next;
    publish();
  });

  // Точка живёт PRESENCE.ttlSec без обновлений: стоящему на месте нужен повтор.
  const heartbeat = setInterval(publish, PRESENCE.heartbeatMs);

  // Сервер мог перезапуститься и забыть точку — после переподключения шлём актуальное состояние.
  const onConnect = () => {
    if (throttle.hasPending) throttle.drain();
    else publish();
  };
  socket.on('connect', onConnect);

  // Возврат из фона: ячейка уже известна — покажемся, как только подтвердится режим (см. выше).

  return () => {
    stopped = true;
    watcher?.remove();
    unsubscribeSession();
    unsubscribePlayer();
    clearInterval(heartbeat);
    socket.off('connect', onConnect);
    const pending = throttle.takePending();
    throttle.dispose();
    // Сокет в фоне закрыт, а последнее состояние терять нельзя — досылаем по HTTP.
    if (pending && isOnboarded()) void api.presenceUpdate(pending).catch(() => undefined);
  };
}

/** Фон и играет музыка: позиция не читается, heartbeat продлевает последнюю ячейку и обновляет трек. */
function startHeartbeat(): () => void {
  let revoked = false;
  const beat = async () => {
    if (revoked || !isOnboarded()) return;
    const decision = backgroundBeat(getFixState(), await currentGateMode());
    switch (decision.kind) {
      case 'stop':
        // Не продлеваем точку тому, кто отозвал геолокацию: через PRESENCE.ttlSec она исчезнет сама.
        revoked = true;
        return;
      case 'skip':
        return;
      case 'downgrade':
        // Точную геопозицию выключили в фоне: сразу заменяем ячейку кварталом, а не продлеваем старую.
        setFixState(decision.next);
        useSession.getState().setLocation(true, true);
        await api
          .presenceUpdate(buildPresenceUpdate(decision.next.cell!, decision.next.motion, true, getNowPlaying()))
          .catch(() => undefined);
        return;
      case 'beat':
        await api.heartbeat(buildHeartbeat(getNowPlaying())).catch(() => undefined);
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), PRESENCE.heartbeatMs);
  return () => {
    clearInterval(timer);
    // Музыка остановилась в фоне: одно последнее «на паузе», дальше точка истекает сама.
    if (AppState.currentState === 'background' && !getNowPlaying().playing) void beat();
  };
}

/**
 * Публикация своей точки. Вызывается один раз в layout вкладок.
 * Пока приложение на экране и геолокация выдана — ячейка по сокету (не чаще PRESENCE.minIntervalMs);
 * в фоне — только HTTP-heartbeat, пока играет музыка.
 */
export function usePresencePublisher(): void {
  const onboarded = useSession((s) => s.onboardedAt !== null);
  const { ok: gateOk } = useLocationGate();
  const appState = useSyncExternalStore(subscribeAppState, appStateSnapshot, appStateSnapshot);
  const playing = useNowPlaying((s) => s.track !== null && s.playing);
  const mode = publisherMode({ onboarded, appState, gateOk, playing });

  useEffect(() => {
    if (!onboarded) resetFixState();
  }, [onboarded]);

  useEffect(() => {
    if (mode === 'watch') return startWatching();
    if (mode === 'heartbeat') return startHeartbeat();
    return undefined;
  }, [mode]);
}
