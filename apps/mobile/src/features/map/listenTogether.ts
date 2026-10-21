import type { ListenState, PresenceView } from '@muzradar/shared';
import { create } from 'zustand';
import { getNowPlaying, player, subscribeNowPlaying, type QueueSource } from '@/features/player';
import { emitAck, getRealtime } from '@/lib/realtime';
import { classifyListenError, estimateListenPosition, LISTEN_ERRORS, serverClock, snapshotFromView } from './listen';

export type ListenStatus = 'idle' | 'joining' | 'joined';

interface ListenTogetherState {
  /** К кому присоединились (или присоединяемся). */
  userId: string | null;
  name: string | null;
  status: ListenStatus;
  error: string | null;
}

const IDLE: ListenTogetherState = { userId: null, name: null, status: 'idle', error: null };

// Состояние живёт вне шторки: закрыли карточку — музыка и синхронизация продолжаются.
export const useListenTogether = create<ListenTogetherState>()(() => IDLE);

const set = (patch: Partial<ListenTogetherState>) => useListenTogether.setState(patch);
const get = () => useListenTogether.getState();
const noop = () => undefined;

let joinSeq = 0;
/** Последний запрошенный трек: пока плеер грузит его, повторный listen:state не должен перезапускать загрузку. */
let requestedTrackId: string | null = null;
let installed = false;
let lastSource: QueueSource | null = null;

function sourceFor(userId: string, name: string): QueueSource {
  return { kind: 'listen', userId, name };
}

function startTrack(state: ListenState, name: string): void {
  if (!state.track) return;
  if (state.track.playback === 'unavailable') {
    set({ error: LISTEN_ERRORS.trackUnavailable });
    return;
  }
  requestedTrackId = state.track.id;
  void player.playTrackId(state.track.id, sourceFor(state.userId, name), estimateListenPosition(state, serverClock.now()));
}

function onListenState(payload: ListenState): void {
  serverClock.note(payload.at);
  const { userId, name, status } = get();
  if (status !== 'joined' || payload.userId !== userId || !payload.track) return;
  const current = getNowPlaying().track?.id ?? null;
  if (payload.track.id === current || payload.track.id === requestedTrackId) return;
  startTrack(payload, name ?? '');
}

function onNowPlayingSource(source: QueueSource | null): void {
  if (source === lastSource) return;
  lastSource = source;
  const { userId, status } = get();
  if (status !== 'joined' || !userId) return;
  // Пользователь сам включил другое — синхронизация больше не нужна
  const ours = source?.kind === 'listen' && source.userId === userId;
  if (!ours) void leaveListening();
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  const socket = getRealtime();
  socket.on('listen:state', onListenState);
  // Сессия не восстановилась — сервер забыл подписку, присоединяемся заново
  socket.on('connect', () => {
    const { userId, status } = get();
    if (status === 'joined' && userId && !socket.recovered) {
      void emitAck<'listen:join', ListenState>('listen:join', { userId }).then(onListenState, noop);
    }
  });
  lastSource = getNowPlaying().source;
  subscribeNowPlaying((np) => onNowPlayingSource(np.source));
}

type ListenTarget = Pick<PresenceView, 'userId' | 'name' | 'track' | 'playing' | 'positionSec' | 'updatedAt'>;

/** «Слушать вместе»: подписка на слушателя и запуск его трека с его позиции. */
export async function joinListening(target: ListenTarget): Promise<void> {
  ensureInstalled();
  const prev = get();
  if (prev.userId && prev.userId !== target.userId && prev.status !== 'idle') {
    void emitAck('listen:leave', { userId: prev.userId }).catch(noop);
  }
  const seq = ++joinSeq;
  requestedTrackId = null;
  set({ userId: target.userId, name: target.name, status: 'joining', error: null });

  let state: ListenState;
  try {
    state = await emitAck<'listen:join', ListenState>('listen:join', { userId: target.userId });
  } catch (err) {
    if (seq !== joinSeq) return;
    const kind = classifyListenError(err);
    if (kind === 'not_available') {
      set({ ...IDLE, error: LISTEN_ERRORS.notAvailable });
      return;
    }
    if (kind === 'offline' && target.track) {
      // Сервер не ответил, но трек виден на карте — включаем его без синхронизации
      set({ ...IDLE, error: LISTEN_ERRORS.offline });
      startTrack(snapshotFromView(target), target.name);
      return;
    }
    set({ ...IDLE, error: LISTEN_ERRORS.failed });
    return;
  }
  if (seq !== joinSeq) return;
  serverClock.note(state.at);
  set({ status: 'joined' });
  // Трека нет (слушатель на паузе между треками) — ждём listen:state
  startTrack(state, target.name);
}

export async function leaveListening(): Promise<void> {
  const { userId } = get();
  joinSeq++;
  requestedTrackId = null;
  set(IDLE);
  if (userId) await emitAck('listen:leave', { userId }).catch(noop);
}

export function clearListenError(): void {
  if (get().error) set({ error: null });
}
