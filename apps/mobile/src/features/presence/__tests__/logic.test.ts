import { CELL_HYSTERESIS, GEO_PRECISION, approxBlockBBox, approxCell, approxCellOf, encodeGeohash, type Track } from '@muzradar/shared';
import {
  applyFix,
  backgroundBeat,
  buildHeartbeat,
  buildPresenceUpdate,
  LatestThrottle,
  playingKey,
  publishableFix,
  publisherMode,
  toTrackRef,
  type Clock,
  type PlayingSnapshot,
  type PublisherInputs,
} from '../logic';

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'audius:abc',
    provider: 'audius',
    title: 'Ночь',
    artist: 'Кино-клуб',
    album: null,
    artworkUrl: null,
    durationSec: 200,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: 'https://cdn.test/1.mp3',
    ...over,
  };
}

const np = (over: Partial<PlayingSnapshot> = {}): PlayingSnapshot => ({ track: track(), playing: true, positionSec: 42.37, ...over });

describe('режим публикации', () => {
  const base: PublisherInputs = { onboarded: true, appState: 'active', gateOk: true, playing: false };

  it('на экране с выданной геолокацией — наблюдение', () => {
    expect(publisherMode(base)).toBe('watch');
    // iOS 'inactive' — шторка уведомлений, а не фон
    expect(publisherMode({ ...base, appState: 'inactive' })).toBe('watch');
  });

  it('без геолокации на экране ничего не шлём', () => {
    expect(publisherMode({ ...base, gateOk: false })).toBe('idle');
  });

  it('в фоне heartbeat только пока играет музыка', () => {
    expect(publisherMode({ ...base, appState: 'background', playing: true })).toBe('heartbeat');
    expect(publisherMode({ ...base, appState: 'background', playing: false })).toBe('idle');
    // в фоне геолокация не читается, поэтому гейт неважен
    expect(publisherMode({ ...base, appState: 'background', playing: true, gateOk: false })).toBe('heartbeat');
  });

  it('до конца онбординга не публикуемся никогда', () => {
    for (const appState of ['active', 'background', null]) {
      expect(publisherMode({ ...base, onboarded: false, appState, playing: true })).toBe('idle');
    }
  });
});

describe('фикс геолокации → ячейка', () => {
  const MOSCOW = { latitude: 55.7558, longitude: 37.6176 };
  const cellOf = (lat: number, lng: number) => encodeGeohash(lat, lng, GEO_PRECISION.client);

  it('первый фикс принимается и даёт ячейку клиентской точности', () => {
    const { next, changed } = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 30, speed: 0 });
    expect(next.cell).toBe(cellOf(MOSCOW.latitude, MOSCOW.longitude));
    expect(next.cell).toHaveLength(GEO_PRECISION.client);
    expect(changed).toBe(true);
  });

  it('первый фикс хуже допустимой точности игнорируется', () => {
    const { next, changed } = applyFix(
      { cell: null, motion: 'still' },
      { ...MOSCOW, accuracy: CELL_HYSTERESIS.firstFixMaxAccuracyM + 1, speed: 1 },
    );
    expect(next.cell).toBeNull();
    expect(changed).toBe(false);
    // движение без ячейки не публикуется
    expect(next.motion).toBe('still');
  });

  it('дрожание внутри той же ячейки ничего не меняет', () => {
    const start = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 20, speed: 0 }).next;
    const again = applyFix(start, { ...MOSCOW, accuracy: 20, speed: 0 });
    expect(again.changed).toBe(false);
    expect(again.next.cell).toBe(start.cell);
  });

  it('смена движения на месте — повод отправить обновление', () => {
    const start = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 20, speed: 0 }).next;
    const walking = applyFix(start, { ...MOSCOW, accuracy: 20, speed: 1.4 });
    expect(walking.next.motion).toBe('walk');
    expect(walking.changed).toBe(true);
    const driving = applyFix(walking.next, { ...MOSCOW, accuracy: 20, speed: 12 });
    expect(driving.next.motion).toBe('drive');
  });

  it('фикс хуже порога не двигает ячейку', () => {
    const start = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 20, speed: 0 }).next;
    const far = applyFix(start, { latitude: 59.94, longitude: 30.31, accuracy: CELL_HYSTERESIS.maxAccuracyM + 1, speed: 0 });
    expect(far.next.cell).toBe(start.cell);
  });

  it('уверенный переезд в другой город ячейку меняет', () => {
    const start = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 20, speed: 0 }).next;
    const spb = applyFix(start, { latitude: 59.9386, longitude: 30.3141, accuracy: 20, speed: 10 });
    expect(spb.next.cell).toBe(cellOf(59.9386, 30.3141));
    expect(spb.changed).toBe(true);
  });

  it('скорость null или -1 считается «стоит»', () => {
    const start = applyFix({ cell: null, motion: 'still' }, { ...MOSCOW, accuracy: 20, speed: 5 }).next;
    expect(applyFix(start, { ...MOSCOW, accuracy: 20, speed: null }).next.motion).toBe('still');
    expect(applyFix(start, { ...MOSCOW, accuracy: 20, speed: -1 }).next.motion).toBe('still');
  });
});

describe('что уходит на сервер', () => {
  it('координат в обновлении нет — только ячейка', () => {
    const update = buildPresenceUpdate('ucftpvj', 'walk', true, np());
    expect(update).toEqual({
      cell: 'ucftpvj',
      motion: 'walk',
      approx: true,
      track: { id: 'audius:abc', title: 'Ночь', artist: 'Кино-клуб', artworkUrl: null, playback: 'full' },
      playing: true,
      positionSec: 42.4,
    });
    expect(Object.keys(update)).not.toEqual(expect.arrayContaining(['lat', 'lng', 'latitude', 'longitude', 'accuracy']));
    expect(JSON.stringify(update)).not.toContain('55.75');
  });

  it('без трека позиция пустая, а «играет» — ложь', () => {
    const update = buildPresenceUpdate('ucftpvj', 'still', false, np({ track: null }));
    expect(update.track).toBeNull();
    expect(update.playing).toBe(false);
    expect(update.positionSec).toBeNull();
    expect(toTrackRef(null)).toBeNull();
  });

  it('heartbeat несёт только трек, паузу и позицию', () => {
    expect(Object.keys(buildHeartbeat(np())).sort()).toEqual(['playing', 'positionSec', 'track']);
    expect(buildHeartbeat(np({ playing: false })).playing).toBe(false);
  });

  it('ключ трека меняется на смене трека и паузе, но не на перемотке', () => {
    expect(playingKey(np())).toBe(playingKey(np({ positionSec: 180 })));
    expect(playingKey(np())).not.toBe(playingKey(np({ playing: false })));
    expect(playingKey(np())).not.toBe(playingKey(np({ track: track({ id: 'jamendo:2' }) })));
    expect(playingKey(np({ track: null, playing: true }))).toBe(playingKey(np({ track: null, playing: false })));
  });
});

// ─── троттлинг ───────────────────────────────────────────────────────────────

class FakeClock implements Clock {
  private t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;

  now() {
    return this.t;
  }
  setTimer(fn: () => void, ms: number) {
    const handle = ++this.id;
    this.timers.set(handle, { at: this.t + ms, fn });
    return handle;
  }
  clearTimer(handle: unknown) {
    this.timers.delete(handle as number);
  }
  /** Двигает время и выполняет сработавшие таймеры в порядке срабатывания. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.t = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.t = target;
  }
  get pendingTimers() {
    return this.timers.size;
  }
}

describe('троттлинг с сохранением последнего', () => {
  const setup = (ok = true) => {
    const clock = new FakeClock();
    const sent: string[] = [];
    let allow = ok;
    const throttle = new LatestThrottle<string>(
      5_000,
      (v) => {
        if (!allow) return false;
        sent.push(v);
        return true;
      },
      clock,
    );
    return { clock, sent, throttle, setAllow: (v: boolean) => (allow = v) };
  };

  it('первое значение уходит сразу', () => {
    const { sent, throttle } = setup();
    throttle.push('a');
    expect(sent).toEqual(['a']);
  });

  it('внутри интервала копит и отправляет только последнее', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    clock.advance(1_000);
    throttle.push('b');
    clock.advance(1_000);
    throttle.push('c');
    expect(sent).toEqual(['a']);
    clock.advance(3_000);
    expect(sent).toEqual(['a', 'c']);
  });

  it('финальное состояние не теряется, даже если после него ничего не приходит', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    throttle.push('final');
    expect(throttle.hasPending).toBe(true);
    clock.advance(10_000);
    expect(sent).toEqual(['a', 'final']);
    expect(throttle.hasPending).toBe(false);
  });

  it('после паузы дольше интервала следующее значение уходит сразу', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    clock.advance(6_000);
    throttle.push('b');
    expect(sent).toEqual(['a', 'b']);
  });

  it('без связи значение ждёт и уходит при drain', () => {
    const { clock, sent, throttle, setAllow } = setup(false);
    throttle.push('a');
    expect(sent).toEqual([]);
    expect(throttle.hasPending).toBe(true);
    clock.advance(10_000);
    expect(sent).toEqual([]);
    setAllow(true);
    throttle.drain();
    expect(sent).toEqual(['a']);
  });

  it('отклонённое сервером возвращается в очередь, но не затирает новое', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    throttle.requeue('a');
    expect(throttle.hasPending).toBe(true);
    clock.advance(5_000);
    expect(sent).toEqual(['a', 'a']);

    throttle.push('new');
    throttle.requeue('old');
    clock.advance(5_000);
    expect(sent).toEqual(['a', 'a', 'new']);
  });

  it('ожидающее можно забрать для отправки другим каналом', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    throttle.push('b');
    expect(throttle.takePending()).toBe('b');
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(sent).toEqual(['a']);
    expect(throttle.takePending()).toBeNull();
  });

  it('после dispose ничего не отправляет и таймеров не оставляет', () => {
    const { clock, sent, throttle } = setup();
    throttle.push('a');
    throttle.push('b');
    throttle.dispose();
    expect(clock.pendingTimers).toBe(0);
    throttle.push('c');
    clock.advance(20_000);
    expect(sent).toEqual(['a']);
  });
});

describe('приблизительная геолокация', () => {
  const HERE = { latitude: 55.7558, longitude: 37.6176 };
  const START = { cell: null, motion: 'still' as const };
  const preciseCell = encodeGeohash(HERE.latitude, HERE.longitude, GEO_PRECISION.client);
  const blockCell = approxCell(HERE.latitude, HERE.longitude);

  it('первый фикс 1800–3000 м при approx даёт ячейку квартала и публикацию', () => {
    for (const accuracy of [1800, 2500, 3000]) {
      const { next, changed } = applyFix(START, { ...HERE, accuracy, speed: 0 }, true);
      expect(next.cell).toBe(blockCell);
      expect(next.approx).toBe(true);
      expect(changed).toBe(true);
    }
  });

  it('в приблизительном режиме наружу не уходит ячейка самой точки', () => {
    expect(blockCell).not.toBe(preciseCell);
  });

  it('точный фикс 80 м — прежнее поведение; грубый фикс в точном режиме по-прежнему отбрасывается', () => {
    const { next, changed } = applyFix(START, { ...HERE, accuracy: 80, speed: 0 });
    expect(next.cell).toBe(preciseCell);
    expect(next.approx).toBe(false);
    expect(changed).toBe(true);
    expect(applyFix(START, { ...HERE, accuracy: 2000, speed: 0 }).next.cell).toBeNull();
  });

  it('грубые скачки внутри квартала не меняют ячейку и ничего не отправляют', () => {
    const coarse = applyFix(START, { ...HERE, accuracy: 2000, speed: 0 }, true).next;
    const [w, s, e, n] = approxBlockBBox(HERE.latitude, HERE.longitude);
    const jitter = applyFix(coarse, { latitude: s + (n - s) * 0.2, longitude: w + (e - w) * 0.8, accuracy: 2500, speed: 0 }, true);
    expect(jitter.next.cell).toBe(coarse.cell);
    expect(jitter.changed).toBe(false);
  });

  it('approx → precise: ячейка сразу сужается до точной', () => {
    const coarse = applyFix(START, { ...HERE, accuracy: 2000, speed: 0 }, true).next;
    const { next, changed } = applyFix(coarse, { ...HERE, accuracy: 30, speed: 0 }, false);
    expect(next.cell).toBe(preciseCell);
    expect(next.approx).toBe(false);
    expect(changed).toBe(true);
  });

  it('approx → precise с плохим точным фиксом: остаёмся видимыми в квартале', () => {
    const coarse = applyFix(START, { ...HERE, accuracy: 2000, speed: 0 }, true).next;
    const bad = applyFix(coarse, { ...HERE, accuracy: CELL_HYSTERESIS.firstFixMaxAccuracyM + 100, speed: 0 }, false);
    expect(bad.next.cell).toBe(blockCell);
    expect(bad.next.approx).toBe(true);
  });

  it('precise → approx: огрубляется сразу, даже если грубый фикс отбракован', () => {
    const fine = applyFix(START, { ...HERE, accuracy: 30, speed: 0 }).next;
    const ok = applyFix(fine, { ...HERE, accuracy: 2000, speed: 0 }, true);
    expect(ok.next).toMatchObject({ cell: blockCell, approx: true });
    expect(ok.changed).toBe(true);
    const rejected = applyFix(fine, { ...HERE, accuracy: CELL_HYSTERESIS.approxMaxAccuracyM + 1, speed: 0 }, true);
    expect(rejected.next).toMatchObject({ cell: approxCellOf(preciseCell), approx: true });
    expect(rejected.changed).toBe(true);
  });

  it('publishableFix не отдаёт точную ячейку, когда режим уже приблизительный', () => {
    const fine = applyFix(START, { ...HERE, accuracy: 30, speed: 0 }).next;
    expect(publishableFix(fine, true)).toEqual({ cell: approxCellOf(preciseCell), motion: 'still', approx: true });
    expect(publishableFix(fine, false)).toEqual({ cell: preciseCell, motion: 'still', approx: false });
    expect(publishableFix(START, true).cell).toBeNull();
  });

  it('ячейка приблизительного пользователя уходит с флагом approx', () => {
    const coarse = applyFix(START, { ...HERE, accuracy: 2000, speed: 0 }, true).next;
    const np = { track: null, playing: false, positionSec: 0 };
    expect(buildPresenceUpdate(coarse.cell!, coarse.motion, coarse.approx ?? false, np)).toMatchObject({ cell: blockCell, approx: true });
  });
});

describe('фоновый heartbeat и режим разрешения', () => {
  const precise = encodeGeohash(55.7558, 37.6176, GEO_PRECISION.client);
  const zone = approxCell(55.7558, 37.6176);

  it('геолокацию отозвали — стоп, точку не продлеваем', () => {
    expect(backgroundBeat({ cell: precise, motion: 'still', approx: false }, 'lost')).toEqual({ kind: 'stop' });
  });

  it('нечего продлевать — пропуск', () => {
    expect(backgroundBeat({ cell: null, motion: 'still' }, 'approx')).toEqual({ kind: 'skip' });
  });

  it('точную выключили в фоне — точная ячейка заменяется кварталом', () => {
    expect(backgroundBeat({ cell: precise, motion: 'walk', approx: false }, 'approx')).toEqual({
      kind: 'downgrade',
      next: { cell: zone, motion: 'walk', approx: true },
    });
  });

  it('режим не изменился — обычный heartbeat', () => {
    expect(backgroundBeat({ cell: precise, motion: 'still', approx: false }, 'precise')).toEqual({ kind: 'beat' });
    expect(backgroundBeat({ cell: zone, motion: 'still', approx: true }, 'approx')).toEqual({ kind: 'beat' });
    // включили точную в фоне: квартал продлевать не вредно, сузится на экране с первым фиксом
    expect(backgroundBeat({ cell: zone, motion: 'still', approx: true }, 'precise')).toEqual({ kind: 'beat' });
  });
});
