import { GENRE_IDS, type ArtistSuggestion, type GenreId } from '@muzradar/shared';
import { uniq } from './moods.ts';
import { interleave } from './normalize.ts';

/**
 * Подсказки артистов на онбординге. Список статичный и только из имён:
 * внешние сервисы на этом шаге не опрашиваются (быстро, без утечки вкуса наружу),
 * фотографий нет — права на них нам никто не давал.
 */
export const ARTISTS_BY_GENRE: Readonly<Record<GenreId, readonly string[]>> = {
  pop: ['Земфира', 'Полина Гагарина', 'Дима Билан', 'Ёлка', 'Dua Lipa', 'The Weeknd', 'Billie Eilish', 'Taylor Swift'],
  hiphop: ['Баста', 'Oxxxymiron', 'Скриптонит', 'Каста', 'Kendrick Lamar', 'Drake', 'Eminem', 'Travis Scott'],
  rock: ['ДДТ', 'Сплин', 'Би-2', 'Мумий Тролль', 'Queen', 'Nirvana', 'Radiohead', 'Muse'],
  russian_rock: [
    'Кино',
    'Наутилус Помпилиус',
    'Алиса',
    'Агата Кристи',
    'Гражданская оборона',
    'Машина времени',
    'Аквариум',
    'Пикник',
  ],
  indie: ['Мумий Тролль', 'Пошлая Молли', 'Arctic Monkeys', 'The Strokes', 'Tame Impala', 'Phoenix', 'alt-J', 'Interpol'],
  electronic: ['Kraftwerk', 'Daft Punk', 'Aphex Twin', 'The Chemical Brothers', 'Moderat', 'Bicep', 'Royksopp', 'Boards of Canada'],
  house: ['Disclosure', 'Kaytranada', 'Black Coffee', 'Purple Disco Machine', 'Gorgon City', 'Lane 8', 'Fisher', 'Jamie Jones'],
  techno: ['Nina Kraviz', 'Charlotte de Witte', 'Amelie Lens', 'Richie Hawtin', 'Ben Klock', 'Adam Beyer', 'Jeff Mills', 'Pan-Pot'],
  dnb: ['Netsky', 'Pendulum', 'Noisia', 'Camo & Krooked', 'Sub Focus', 'Andy C', 'Hybrid Minds', 'Wilkinson'],
  phonk: ['Kordhell', 'DVRST', 'MoonDeity', 'Freddie Dredd', 'Ghostface Playa', 'SXMPRA', 'Pharmacist', 'Kaito Shoma'],
  trap: ['Big Baby Tape', 'Скриптонит', 'Future', 'Travis Scott', 'Gunna', 'Metro Boomin', '21 Savage', 'Playboi Carti'],
  rnb: ['SZA', 'Frank Ocean', 'Daniel Caesar', 'Jorja Smith', 'Brent Faiyaz', 'Snoh Aalegra', 'H.E.R.', 'Miguel'],
  jazz: ['Игорь Бутман', 'Miles Davis', 'John Coltrane', 'Bill Evans', 'Nina Simone', 'Kamasi Washington', 'Norah Jones', 'Esperanza Spalding'],
  blues: ['B.B. King', 'Muddy Waters', 'John Lee Hooker', 'Gary Clark Jr.', 'Joe Bonamassa', 'Stevie Ray Vaughan', 'Etta James', 'Buddy Guy'],
  classical: [
    'Пётр Чайковский',
    'Сергей Рахманинов',
    'Дмитрий Шостакович',
    'Игорь Стравинский',
    'Johann Sebastian Bach',
    'Ludwig van Beethoven',
    'Frederic Chopin',
    'Claude Debussy',
  ],
  soundtrack: [
    'Эдуард Артемьев',
    'Hans Zimmer',
    'Ennio Morricone',
    'Ludovico Einaudi',
    'Olafur Arnalds',
    'Max Richter',
    'John Williams',
    'Ryuichi Sakamoto',
  ],
  metal: ['Ария', 'Кипелов', 'Metallica', 'Iron Maiden', 'System of a Down', 'Slipknot', 'Gojira', 'Rammstein'],
  punk: ['Король и Шут', 'Тараканы!', 'Наив', 'Green Day', 'The Offspring', 'Ramones', 'Bad Religion', 'Sex Pistols'],
  folk: ['Пелагея', 'Иван Купала', 'Otyken', 'Mumford & Sons', 'Fleet Foxes', 'Bon Iver', 'The Lumineers', 'Heilung'],
  reggae: ['Bob Marley', 'Peter Tosh', 'Jimmy Cliff', 'Burning Spear', 'Damian Marley', 'Toots and the Maytals', 'Alborosie', 'Protoje'],
  latin: ['Bad Bunny', 'Shakira', 'Rosalia', 'J Balvin', 'Buena Vista Social Club', 'Gipsy Kings', 'Carlos Santana', 'Celia Cruz'],
  kpop: ['BTS', 'BLACKPINK', 'TWICE', 'Stray Kids', 'NewJeans', 'IU', 'SEVENTEEN', 'aespa'],
  lofi: ['Nujabes', 'J Dilla', 'Jinsang', 'Idealism', 'Kupla', 'Philanthrope', 'Tomppabeats', 'Sleepy Fish'],
  ambient: ['Brian Eno', 'Stars of the Lid', 'Tim Hecker', 'Hiroshi Yoshimura', 'Biosphere', 'Loscil', 'Harold Budd', 'Steve Roach'],
  estrada: [
    'Алла Пугачёва',
    'Муслим Магомаев',
    'Валерий Леонтьев',
    'Анна Герман',
    'София Ротару',
    'Эдита Пьеха',
    'Иосиф Кобзон',
    'Лев Лещенко',
  ],
  chanson: [
    'Владимир Высоцкий',
    'Михаил Круг',
    'Александр Розенбаум',
    'Булат Окуджава',
    'Григорий Лепс',
    'Любэ',
    'Вилли Токарев',
    'Трофим',
  ],
};

/** Сколько имён отдаём максимум: экран онбординга всё равно не покажет больше. */
export const ARTIST_SUGGESTIONS_MAX = 48;

/**
 * Имена по выбранным жанрам, вперемешку: иначе первый жанр занимает весь экран.
 * Пустой список жанров — подсказки по всем жанрам.
 */
export function artistSuggestions(genres: readonly GenreId[], limit = ARTIST_SUGGESTIONS_MAX): ArtistSuggestion[] {
  const requested = genres.length > 0 ? uniq(genres) : [...GENRE_IDS];
  const lists = requested.map((genre) => ARTISTS_BY_GENRE[genre].map((name) => ({ name, genre })));
  const picked = new Map<string, ArtistSuggestion>();
  for (const { name, genre } of interleave(lists)) {
    const existing = picked.get(name);
    if (existing) {
      if (!existing.genres.includes(genre)) existing.genres.push(genre);
      continue;
    }
    if (picked.size >= limit) continue;
    picked.set(name, { name, imageUrl: null, genres: [genre] });
  }
  return [...picked.values()];
}
