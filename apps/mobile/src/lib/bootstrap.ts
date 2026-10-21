import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSession } from '@/state/session';
import { ApiError, authenticate, NetworkError } from './api';
import { connectRealtime, disconnectRealtime } from './realtime';

/**
 * Жизненный цикл сессии:
 * - вернувшийся пользователь: обмен секрета на токен в фоне, карта показывается сразу из кэша;
 * - при возврате из фона токен освежается;
 * - реалтайм живёт, пока онбординг пройден и приложение на экране
 *   (в фоне позицию не шлём, трек уходит HTTP-heartbeat'ом).
 */
export function useBootstrap(onboarded: boolean) {
  const hasAccount = useSession((s) => s.userId !== null);

  useEffect(() => {
    if (!onboarded && !hasAccount) return;
    authenticate().catch((err: unknown) => {
      if (err instanceof NetworkError) return; // офлайн — работаем из кэша
      if (err instanceof ApiError && err.status >= 500) return;
      console.warn('[bootstrap] auth failed', err);
    });
  }, [onboarded, hasAccount]);

  useEffect(() => {
    if (!onboarded) {
      disconnectRealtime();
      return;
    }
    if (AppState.currentState === 'active') connectRealtime();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        authenticate().catch(() => undefined);
        connectRealtime();
      } else if (state === 'background') {
        disconnectRealtime();
      }
    });
    return () => {
      sub.remove();
      disconnectRealtime();
    };
  }, [onboarded]);
}
