import type { Section, Track } from '@muzradar/shared';
import { render, screen } from '@testing-library/react-native';
import { SectionRail } from '../SectionRail';
import { selectSections } from '../sections';

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'audius:abc',
    provider: 'audius',
    title: 'Ночь',
    artist: 'Кино-клуб',
    album: null,
    artworkUrl: null,
    durationSec: 215,
    playback: 'full',
    previewSec: null,
    genres: [],
    isrc: null,
    licenseUrl: null,
    streamUrl: 'https://s.test/a.mp3',
    ...over,
  };
}

const NOTICE = 'Источник временно недоступен — русский каталог появится, когда подключим источник. Jamendo не подключён.';

const russian: Section = { id: 'russian', title: 'На русском', subtitle: 'Русскоязычные исполнители', tracks: [], notice: NOTICE };

describe('разделы витрины', () => {
  it('раздел с пометкой остаётся и без треков, пустой без пометки скрыт', () => {
    const sections = selectSections({
      sections: [
        { id: 'for_you', title: 'Для вас', subtitle: null, tracks: [track()] },
        russian,
        { id: 'new', title: 'Новое', subtitle: null, tracks: [], notice: null },
        // после фильтра клиента пусто — раздел пропадает, как и раньше
        { id: 'popular', title: 'Популярное', subtitle: null, tracks: [track({ id: 'deezer:1', provider: 'deezer' })] },
      ],
    });
    expect(sections.map((s) => s.id)).toEqual(['for_you', 'russian']);
  });

  // findBy — чтобы асинхронная подгрузка шрифта иконок прошла внутри act
  it('лента без треков показывает заголовок и пометку вместо карточек', async () => {
    render(<SectionRail section={russian} activeTrackId={null} onPlay={jest.fn()} />);
    expect(await screen.findByText('На русском')).toBeTruthy();
    expect(screen.getByText(NOTICE)).toBeTruthy();
    expect(screen.queryByLabelText(/На русском: \d+ треков/)).toBeNull();
  });

  it('обычная лента — карточки без пометки', async () => {
    render(
      <SectionRail
        section={{ id: 'for_you', title: 'Для вас', subtitle: null, tracks: [track()], notice: null }}
        activeTrackId={null}
        onPlay={jest.fn()}
      />,
    );
    expect(await screen.findByLabelText('Для вас: 1 треков')).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
