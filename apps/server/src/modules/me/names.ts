/**
 * Серверный фильтр имён. Клиентский фильтр — только подсказка, решение принимается здесь.
 * Список намеренно короткий: корни проверяются подстрокой, и каждый лишний корень
 * бьёт по настоящим именам (Аманда, Глеб, Asuka, Xue, Nguyen Huy).
 */

// Корни в нормализованном виде: ё → е, й → и (диакритика снимается целиком).
const OBSCENE_ROOTS = [
  'хуи', 'хуе', 'хуя', 'хую', 'пизд', 'ебан', 'ебал', 'ебат', 'ебуч', 'еблан', 'ебло', 'ебну',
  'заеб', 'выеб', 'уеб', 'бляд', 'блят', 'мудак', 'мудил', 'пидор', 'пидар', 'пидр', 'залуп',
  'гандон', 'гондон', 'шлюх', 'гитлер',
  'fuck', 'cunt', 'bitch', 'whore', 'faggot', 'nigger', 'nigga', 'pussy', 'asshole', 'dickhead',
  'huj', 'pizd', 'blyad', 'blyat', 'pidor', 'pidar', 'mudak', 'zalup', 'gandon', 'hitler',
];

// Выдача себя за сервис; проверяется по имени без разделителей.
const RESERVED_WORDS = [
  'admin', 'админ', 'support', 'саппорт', 'поддержк', 'moderator', 'модератор', 'muzradar', 'музрадар',
];

// Латиница и цифры, похожие на кириллицу (в нижнем регистре; b и h — по заглавным В и Н).
// u не переводится в «у» намеренно: иначе пиньинь Xue превращался бы в мат.
const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', n: 'п', o: 'о', p: 'р', r: 'г', t: 'т',
  x: 'х', y: 'у', '0': 'о', '3': 'з', '4': 'ч', '6': 'б',
};

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', в: 'b', ь: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', п: 'n', о: 'o', р: 'p', г: 'r',
  т: 't', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
};

const GREEK_TO_LATIN: Record<string, string> = {
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
};

const SEPARATORS = /[\s._-]+/u;

function mapChars(value: string, table: Record<string, string>): string {
  let out = '';
  for (const ch of value) out += table[ch] ?? ch;
  return out;
}

function baseNormalize(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е').normalize('NFKD').replace(/\p{M}/gu, '');
}

const collapseRepeats = (value: string) => value.replace(/(.)\1+/gu, '$1');

/** Одно и то же слово в «кириллическом» и «латинском» прочтении, с растянутыми буквами и без. */
function readings(word: string): string[] {
  const latinish = mapChars(word, GREEK_TO_LATIN);
  const cyrillic = mapChars(latinish, LATIN_TO_CYRILLIC);
  const latin = mapChars(latinish, CYRILLIC_TO_LATIN);
  return [cyrillic, latin, collapseRepeats(cyrillic), collapseRepeats(latin)];
}

/**
 * Разделители убираются только вокруг коротких кусков («х у й», «f.u.c.k»): склейка
 * всех слов подряд ловила бы корни на стыке — «Глеб Анатольевич» → «глЕБАНатольевич».
 */
function words(tokens: string[]): string[] {
  const out: string[] = [];
  let current = '';
  let prevShort = false;
  for (const token of tokens) {
    const short = [...token].length <= 2;
    if (current && (short || prevShort)) current += token;
    else {
      if (current) out.push(current);
      current = token;
    }
    prevShort = short;
  }
  if (current) out.push(current);
  return out;
}

export type NameRejection = 'obscene' | 'reserved';

export function checkName(name: string): NameRejection | null {
  const tokens = baseNormalize(name).split(SEPARATORS).filter(Boolean);
  for (const word of words(tokens)) {
    const forms = readings(word);
    if (OBSCENE_ROOTS.some((root) => forms.some((f) => f.includes(root)))) return 'obscene';
  }
  const joined = readings(tokens.join(''));
  if (RESERVED_WORDS.some((w) => joined.some((f) => f.includes(w)))) return 'reserved';
  return null;
}
