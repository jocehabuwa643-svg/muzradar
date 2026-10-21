import type { ClusterCell, PresenceView, Viewport, ViewportAck } from '@muzradar/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { emitAck, getRealtime } from '@/lib/realtime';
import { EMPTY_FEED, feedList, feedReducer, isLiveZoom, type FeedAction, type FeedState } from './features';
import { serverClock } from './listen';

export type FeedMode = 'live' | 'clusters';
export type FeedStatus = 'idle' | 'loading' | 'ready' | 'error';

// useReducer ждёт редьюсер ровно с двумя аргументами
const reduceFeed = (state: FeedState, action: FeedAction) => feedReducer(state, action);

/** Кластеры по HTTP обновляются опросом, пока вкладка на экране. */
export const CLUSTER_POLL_MS = 15_000;

export interface PresenceFeed {
  mode: FeedMode;
  status: FeedStatus;
  listeners: PresenceView[];
  clusters: ClusterCell[];
  /** Сколько слушателей в кадре (без себя в живом режиме). */
  count: number;
  retry: () => void;
}

/**
 * Лента присутствия для вьюпорта карты.
 * Зум от PRESENCE.liveMinZoom — снимок из ack `viewport:set` и дальше дельты `presence:delta`;
 * мельче — кластеры по HTTP раз в CLUSTER_POLL_MS. Без сокета — HTTP-снимок, пока связь не вернётся.
 */
export function usePresenceFeed(viewport: Viewport | null, opts: { focused: boolean; selfId: string | null }): PresenceFeed {
  const { focused, selfId } = opts;
  const [feed, dispatch] = useReducer(reduceFeed, EMPTY_FEED);
  const [mode, setMode] = useState<FeedMode>('live');
  const [cells, setCells] = useState<ClusterCell[]>([]);
  const [status, setStatus] = useState<FeedStatus>('idle');
  const [attempt, setAttempt] = useState(0);

  const selfRef = useRef(selfId);
  selfRef.current = selfId;
  const modeRef = useRef<FeedMode>('live');

  // Дельты: только пока вкладка на экране; при возврате снимок придёт заново.
  useEffect(() => {
    if (!focused) return;
    const socket = getRealtime();
    const onDelta = (p: { upserts: PresenceView[]; removes: string[]; at: number }) => {
      serverClock.note(p.at);
      if (modeRef.current !== 'live') return;
      dispatch({ type: 'delta', upserts: p.upserts, removes: p.removes, selfId: selfRef.current, at: p.at });
    };
    socket.on('presence:delta', onDelta);
    return () => {
      socket.off('presence:delta', onDelta);
    };
  }, [focused]);

  useEffect(() => {
    if (!focused || !viewport) return;
    const socket = getRealtime();
    let cancelled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let abort: AbortController | null = null;

    const nextSignal = () => {
      abort?.abort();
      abort = new AbortController();
      return abort.signal;
    };
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const failed = () => {
      // Старые данные лучше ошибки: ошибку показываем, только если показывать нечего
      if (!cancelled) setStatus((s) => (s === 'ready' ? s : 'error'));
    };

    const fetchClusters = async () => {
      const signal = nextSignal();
      try {
        const res = await api.clusters(viewport.bbox, viewport.zoom, signal);
        if (cancelled || signal.aborted) return;
        setCells(res.cells);
        setStatus('ready');
      } catch {
        if (!signal.aborted) failed();
      }
    };

    const enterClusters = () => {
      modeRef.current = 'clusters';
      setMode('clusters');
      dispatch({ type: 'clear' });
      void fetchClusters();
      poll ??= setInterval(() => void fetchClusters(), CLUSTER_POLL_MS);
    };

    const enterLive = (users: readonly PresenceView[]) => {
      stopPoll();
      modeRef.current = 'live';
      setMode('live');
      setCells([]);
      dispatch({ type: 'snapshot', users, selfId: selfRef.current });
      setStatus('ready');
    };

    const viaHttp = async () => {
      if (!isLiveZoom(viewport.zoom)) {
        enterClusters();
        return;
      }
      const signal = nextSignal();
      try {
        const res = await api.nearby(viewport.bbox, viewport.zoom, signal);
        if (!cancelled && !signal.aborted) enterLive(res.users);
      } catch {
        if (!signal.aborted) failed();
      }
    };

    const sync = async () => {
      if (!socket.connected) {
        await viaHttp();
        return;
      }
      try {
        const ack = await emitAck<'viewport:set', ViewportAck>('viewport:set', viewport);
        if (cancelled) return;
        if (ack.mode === 'live') enterLive(ack.users);
        else enterClusters();
      } catch {
        if (!cancelled) await viaHttp();
      }
    };

    setStatus((s) => (s === 'ready' ? s : 'loading'));
    void sync();

    // Сессия не восстановилась — сервер забыл комнаты вьюпорта
    const onConnect = () => {
      if (!socket.recovered) void sync();
    };
    socket.on('connect', onConnect);

    return () => {
      cancelled = true;
      socket.off('connect', onConnect);
      stopPoll();
      abort?.abort();
    };
  }, [focused, viewport, attempt]);

  const listeners = useMemo(() => feedList(feed), [feed]);
  const count = mode === 'live' ? listeners.length : cells.reduce((sum, c) => sum + c.count, 0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { mode, status, listeners, clusters: cells, count, retry };
}
