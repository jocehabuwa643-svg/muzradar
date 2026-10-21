import {
  currentTrack,
  decidePrev,
  nextQueue,
  orderedTracks,
  peekNext,
  prevQueue,
  replaceQueue,
  setShuffleQueue,
  shuffledOrder,
  type QueueState,
} from '../queue';
import { makeTrack, tracks } from '../__fixtures__/tracks';

/** Детерминированный «рандом» для перемешивания. */
function seeded(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const ids = (q: QueueState) => orderedTracks(q).map((t) => t.id);

describe('очередь', () => {
  it('без перемешивания начинает с выбранного трека в исходном порядке', () => {
    const q = replaceQueue(tracks(1, 2, 3, 4), 2, false);
    expect(currentTrack(q)?.id).toBe('audius:t3');
    expect(q.index).toBe(2);
    expect(ids(q)).toEqual(['audius:t1', 'audius:t2', 'audius:t3', 'audius:t4']);
  });

  it('пустая очередь — нет текущего трека', () => {
    const q = replaceQueue([], 0, false);
    expect(currentTrack(q)).toBeNull();
    expect(nextQueue(q)).toBeNull();
    expect(prevQueue(q)).toBeNull();
  });

  it('next идёт по порядку и возвращает null в конце (повтора нет)', () => {
    let q: QueueState | null = replaceQueue(tracks(1, 2, 3), 0, false);
    q = nextQueue(q);
    expect(q && currentTrack(q)?.id).toBe('audius:t2');
    q = q && nextQueue(q);
    expect(q && currentTrack(q)?.id).toBe('audius:t3');
    expect(q && nextQueue(q)).toBeNull();
  });

  it('prev возвращается по истории, а без истории — на трек раньше по порядку', () => {
    const start = replaceQueue(tracks(1, 2, 3), 1, false);
    // истории нет: назад по порядку
    expect(currentTrack(prevQueue(start)!)?.id).toBe('audius:t1');

    const afterNext = nextQueue(start)!;
    const back = prevQueue(afterNext)!;
    expect(currentTrack(back)?.id).toBe('audius:t2');
    expect(back.history).toEqual([]);
    // с первого трека без истории назад некуда
    expect(prevQueue(replaceQueue(tracks(1, 2), 0, false))).toBeNull();
  });

  it('пропущенный без прослушивания трек не попадает в историю', () => {
    const q = replaceQueue(tracks(1, 2, 3), 0, false);
    const skipped = nextQueue(q, false)!;
    expect(skipped.history).toEqual([]);
    const played = nextQueue(q, true)!;
    expect(played.history).toEqual([0]);
  });

  describe('«назад»: первые 3 секунды — предыдущий трек, позже — начало текущего', () => {
    const q = nextQueue(replaceQueue(tracks(1, 2, 3), 0, false))!;

    it('в первые 3 с — предыдущий трек', () => {
      const d = decidePrev(q, 2.9);
      expect(d.kind).toBe('track');
      expect(d.kind === 'track' && currentTrack(d.state)?.id).toBe('audius:t1');
    });

    it('с 3 с — перезапуск текущего', () => {
      expect(decidePrev(q, 3).kind).toBe('restart');
      expect(decidePrev(q, 95).kind).toBe('restart');
    });

    it('на первом треке — перезапуск', () => {
      expect(decidePrev(replaceQueue(tracks(1, 2), 0, false), 0.5).kind).toBe('restart');
    });

    it('перескакивает недоступные треки назад', () => {
      const list = [makeTrack(1), makeTrack(2, { playback: 'unavailable' }), makeTrack(3)];
      const at3 = replaceQueue(list, 2, false);
      const d = decidePrev(at3, 0, (t) => t.playback !== 'unavailable');
      expect(d.kind === 'track' && currentTrack(d.state)?.id).toBe('audius:t1');
    });
  });

  describe('перемешивание', () => {
    it('shuffledOrder — перестановка с заданным первым', () => {
      const order = shuffledOrder(10, 4, seeded());
      expect(order[0]).toBe(4);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('новая очередь с перемешиванием начинается с выбранного трека', () => {
      const q = replaceQueue(tracks(1, 2, 3, 4, 5), 3, true, seeded());
      expect(q.index).toBe(0);
      expect(currentTrack(q)?.id).toBe('audius:t4');
      expect(new Set(ids(q)).size).toBe(5);
    });

    it('включение не прерывает текущий трек, выключение возвращает исходный порядок', () => {
      const q = nextQueue(replaceQueue(tracks(1, 2, 3, 4, 5), 0, false))!;
      const on = setShuffleQueue(q, true, seeded(3));
      expect(on.shuffle).toBe(true);
      expect(on.index).toBe(0);
      expect(currentTrack(on)?.id).toBe('audius:t2');
      expect(on.history).toEqual(q.history);

      const off = setShuffleQueue(on, false);
      expect(off.shuffle).toBe(false);
      expect(ids(off)).toEqual(['audius:t1', 'audius:t2', 'audius:t3', 'audius:t4', 'audius:t5']);
      expect(currentTrack(off)?.id).toBe('audius:t2');
    });

    it('повторное включение — без изменений', () => {
      const q = replaceQueue(tracks(1, 2, 3), 0, true, seeded());
      expect(setShuffleQueue(q, true)).toBe(q);
    });
  });

  it('peekNext пропускает то, что играть нельзя', () => {
    const list = [makeTrack(1), makeTrack(2, { streamUrl: null }), makeTrack(3)];
    const q = replaceQueue(list, 0, false);
    expect(peekNext(q, (t) => t.streamUrl !== null)?.id).toBe('audius:t3');
    expect(peekNext(replaceQueue(list, 2, false))).toBeNull();
  });
});
