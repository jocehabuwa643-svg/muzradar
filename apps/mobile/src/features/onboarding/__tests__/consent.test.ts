import { ConsentsInput, LEGAL_VERSIONS } from '@muzradar/shared';
import {
  allConsentsGiven,
  buildConsentsInput,
  canSubmitConsents,
  checkBirthYear,
  DISSEMINATION_SCOPE,
  LEGAL_URLS,
  NO_CONSENTS,
  toggleConsent,
  type AcceptedAt,
} from '../consent';

// birthYearBounds для 2026: min 1926, max 2010
const NOW = new Date('2026-09-18T10:00:00.000Z');

describe('checkBirthYear', () => {
  test.each<[string, ReturnType<typeof checkBirthYear>['status'], boolean | null]>([
    ['', 'empty', null],
    ['   ', 'empty', null],
    ['2', 'incomplete', null],
    ['200', 'incomplete', null],
    ['20a1', 'invalid', null],
    ['-200', 'invalid', null],
    ['20011', 'invalid', null],
    ['2027', 'invalid', null],
    ['2026', 'underage', null],
    ['2011', 'underage', null],
    ['2010', 'ok', true],
    ['2009', 'ok', true],
    ['2008', 'ok', false],
    ['1990', 'ok', false],
    ['1926', 'ok', false],
    ['1925', 'invalid', null],
  ])('«%s» → %s', (input, status, minor) => {
    // у каждой строки три значения: иначе jest.each примет третий параметр за done-колбэк
    const r = checkBirthYear(input, NOW);
    expect(r.status).toBe(status);
    if (r.status === 'ok') {
      expect(r.year).toBe(Number(input));
      expect(r.minor).toBe(minor);
    }
  });

  test('у отказа по возрасту понятное сообщение', () => {
    const r = checkBirthYear('2012', NOW);
    expect(r.status === 'underage' && r.message).toBe('МУЗРАДАР доступен с 16 лет');
  });
});

describe('галочки согласий', () => {
  test('по умолчанию ни одна не отмечена', () => {
    expect(NO_CONSENTS).toEqual({ processing: null, dissemination: null, rules: null });
    expect(allConsentsGiven(NO_CONSENTS)).toBe(false);
  });

  test('отметка фиксирует время, повторное нажатие его стирает', () => {
    const on = toggleConsent(NO_CONSENTS, 'dissemination', NOW);
    expect(on.dissemination).toBe('2026-09-18T10:00:00.000Z');
    expect(on.processing).toBeNull();
    const off = toggleConsent(on, 'dissemination', new Date('2026-09-18T10:05:00.000Z'));
    expect(off.dissemination).toBeNull();
  });

  test('отправить можно только с годом и всеми тремя галочками', () => {
    const ok = checkBirthYear('1999', NOW);
    const two: AcceptedAt = { processing: NOW.toISOString(), dissemination: NOW.toISOString(), rules: null };
    const all: AcceptedAt = { ...two, rules: NOW.toISOString() };
    expect(canSubmitConsents(ok, two)).toBe(false);
    expect(canSubmitConsents(ok, all)).toBe(true);
    expect(canSubmitConsents(checkBirthYear('2012', NOW), all)).toBe(false);
    expect(canSubmitConsents(checkBirthYear('19', NOW), all)).toBe(false);
  });

  test('ссылки на документы — отдельные для каждого согласия', () => {
    expect(LEGAL_URLS).toEqual({
      processing: 'https://muzradar.app/legal/processing',
      dissemination: 'https://muzradar.app/legal/dissemination',
      rules: 'https://muzradar.app/legal/rules',
    });
  });
});

describe('buildConsentsInput', () => {
  const t1 = '2026-09-18T10:00:01.000Z';
  const t2 = '2026-09-18T10:00:07.000Z';
  const t3 = '2026-09-18T10:00:12.000Z';

  test('без любой из галочек тело не собирается', () => {
    expect(buildConsentsInput(1999, NO_CONSENTS)).toBeNull();
    expect(buildConsentsInput(1999, { processing: t1, dissemination: t2, rules: null })).toBeNull();
    expect(buildConsentsInput(1999, { processing: null, dissemination: t2, rules: t3 })).toBeNull();
  });

  test('собирает тело по контракту: версии документов, время каждой отметки, полный перечень данных', () => {
    const input = buildConsentsInput(1999, { processing: t1, dissemination: t2, rules: t3 });
    expect(input).not.toBeNull();
    expect(ConsentsInput.parse(input)).toEqual(input);
    expect(input).toEqual({
      birthYear: 1999,
      consents: {
        processing: { version: LEGAL_VERSIONS.processing, acceptedAt: t1 },
        dissemination: { version: LEGAL_VERSIONS.dissemination, acceptedAt: t2, scope: ['name', 'avatar', 'track', 'location'] },
        rules: { version: LEGAL_VERSIONS.rules, acceptedAt: t3 },
      },
    });
  });

  test('перечень распространяемых данных совпадает с текстом галочки: имя, фото, трек, место', () => {
    expect([...DISSEMINATION_SCOPE].sort()).toEqual(['avatar', 'location', 'name', 'track']);
  });

  test('битое время не проходит схему', () => {
    expect(buildConsentsInput(1999, { processing: 'вчера', dissemination: t2, rules: t3 })).toBeNull();
  });
});
