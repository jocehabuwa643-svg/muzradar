import { GENRE_IDS, LIMITS, Taste, type GenreId } from '@muzradar/shared';
import { addArtist, checkTaste, plural, tasteFromDraft, toggleArtist, toggleGenre, toggleMood, type TasteDraft } from '../taste';

const draft = (patch: Partial<TasteDraft> = {}): TasteDraft => ({ genres: [], moods: [], artists: [], ...patch });

describe('жанры', () => {
  test('выбор и снятие', () => {
    const on = toggleGenre(['rock'], 'jazz');
    expect(on).toEqual({ next: ['rock', 'jazz'], limited: false });
    expect(toggleGenre(on.next, 'rock')).toEqual({ next: ['jazz'], limited: false });
  });

  test(`больше ${LIMITS.tasteGenresMax} не выбрать, но снять можно`, () => {
    const full = GENRE_IDS.slice(0, LIMITS.tasteGenresMax) as GenreId[];
    const extra = GENRE_IDS[LIMITS.tasteGenresMax]!;
    expect(toggleGenre(full, extra)).toEqual({ next: full, limited: true });
    expect(toggleGenre(full, full[0]!).next).toHaveLength(LIMITS.tasteGenresMax - 1);
  });
});

test('настроения переключаются', () => {
  expect(toggleMood([], 'night')).toEqual(['night']);
  expect(toggleMood(['night', 'drive'], 'night')).toEqual(['drive']);
});

describe('артисты', () => {
  test('имя чистится от лишних пробелов', () => {
    expect(addArtist([], '  Кино  ')).toEqual({ next: ['Кино'], error: null });
    expect(addArtist([], 'Сплин \n  и друзья').next).toEqual(['Сплин и друзья']);
  });

  test.each<[string, string[], string, string]>([
    ['пустое', [], '   ', 'empty'],
    ['повтор без учёта регистра', ['Земфира'], 'земфира', 'duplicate'],
    ['слишком длинное', [], 'x'.repeat(81), 'too-long'],
    ['лимит', Array.from({ length: LIMITS.tasteArtistsMax }, (_, i) => `Артист ${i}`), 'Ещё один', 'limit'],
  ])('%s → %s', (_name, list, raw, error) => {
    const r = addArtist(list, raw);
    expect(r.error).toBe(error);
    expect(r.next).toEqual(list);
  });

  test('тап по выбранной подсказке снимает её, по невыбранной — добавляет', () => {
    expect(toggleArtist(['Кино'], 'кино')).toEqual({ next: [], error: null });
    expect(toggleArtist(['Кино'], 'Aigel')).toEqual({ next: ['Кино', 'Aigel'], error: null });
  });
});

describe('checkTaste', () => {
  test('пустой черновик: не готово, подсказка про жанры', () => {
    const c = checkTaste(draft());
    expect(c.taste).toBeNull();
    expect(c.hint).toBe('Выберите ещё 3 жанра');
  });

  test('подсказки идут по порядку: жанры → настроение → артисты', () => {
    expect(checkTaste(draft({ genres: ['rock', 'jazz'] })).hint).toBe('Выберите ещё 1 жанр');
    expect(checkTaste(draft({ genres: ['rock', 'jazz', 'indie'] })).hint).toBe('Выберите хотя бы одно настроение');
    expect(checkTaste(draft({ genres: ['rock', 'jazz', 'indie'], moods: ['night'] })).hint).toBe('Добавьте хотя бы одного артиста');
  });

  test('полный вкус проходит общую схему', () => {
    const c = checkTaste(draft({ genres: ['rock', 'jazz', 'indie'], moods: ['night'], artists: ['Кино'] }));
    expect(c.hint).toBeNull();
    expect(c.taste).not.toBeNull();
    expect(Taste.parse(c.taste)).toEqual(c.taste);
    expect(c.genres).toEqual({ count: 3, ok: true, atMax: false });
  });

  test('перебор жанров (если черновик испорчен) не отправляется', () => {
    const c = checkTaste(draft({ genres: GENRE_IDS.slice(0, LIMITS.tasteGenresMax + 1) as GenreId[], moods: ['night'], artists: ['Кино'] }));
    expect(c.genres.ok).toBe(false);
    expect(c.taste).toBeNull();
  });
});

test('черновик из хранилища очищается от устаревших значений и повторов', () => {
  const restored = tasteFromDraft({
    genres: ['rock', 'rock', 'vaporwave' as GenreId, 'jazz'],
    moods: ['night', 'night'],
    artists: ['Кино', 'кино', '  ', 'Aigel'],
  });
  expect(restored).toEqual({ genres: ['rock', 'jazz'], moods: ['night'], artists: ['Кино', 'Aigel'] });
  expect(tasteFromDraft(undefined)).toEqual(draft());
});

test.each<[number, string]>([
  [1, 'жанр'],
  [2, 'жанра'],
  [4, 'жанра'],
  [5, 'жанров'],
  [11, 'жанров'],
  [12, 'жанров'],
  [21, 'жанр'],
  [22, 'жанра'],
])('plural(%i) → %s', (n, word) => {
  expect(plural(n, ['жанр', 'жанра', 'жанров'])).toBe(word);
});
