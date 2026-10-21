import Ionicons from '@expo/vector-icons/Ionicons';
import type { Section, Track } from '@muzradar/shared';
import { router } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, TextInput, View, type ListRenderItem } from 'react-native';
import { SectionRail } from '@/features/catalog/SectionRail';
import { SkeletonRails, SkeletonRows } from '@/features/catalog/Skeleton';
import { TrackRow } from '@/features/catalog/TrackRow';
import { useSearch, type SearchState } from '@/features/catalog/useSearch';
import { useSections } from '@/features/catalog/useSections';
import { getNowPlaying, player, useNowPlaying, type QueueSource } from '@/features/player';
import { Button, IconButton, Notice, Screen, Txt } from '@/ui/components';
import { colors, fonts, HIT, radius, space } from '@/ui/theme';

/** Нажали на то, что уже играет, — открываем плеер, а не начинаем трек заново. */
function playFrom(list: readonly Track[], index: number, source: QueueSource) {
  const now = getNowPlaying();
  const tapped = list[index];
  if (tapped && now.track?.id === tapped.id) {
    if (!now.playing) player.play();
    router.push('/player');
    return;
  }
  void player.playQueue(list, index, source);
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.search}>
      <Ionicons name="search" size={20} color={colors.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Трек, артист или жанр"
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.violet}
        cursorColor={colors.violet}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={200}
        accessibilityLabel="Поиск музыки"
        style={styles.searchInput}
      />
      {value ? <IconButton icon="close-circle" label="Очистить поиск" onPress={() => onChange('')} size={20} color={colors.textMuted} /> : null}
    </View>
  );
}

function CenteredMessage({ icon, title, text }: { icon: 'search' | 'musical-notes-outline'; title: string; text: string }) {
  return (
    <View style={styles.message}>
      <Ionicons name={icon} size={40} color={colors.violet} />
      <Txt variant="heading" align="center">
        {title}
      </Txt>
      <Txt color={colors.textMuted} align="center">
        {text}
      </Txt>
    </View>
  );
}

function SearchResults({ search, activeTrackId }: { search: SearchState; activeTrackId: string | null }) {
  const { tracks, query } = search;
  const onPlay = useCallback((index: number) => playFrom(tracks, index, { kind: 'search', query }), [tracks, query]);
  const renderItem = useCallback<ListRenderItem<Track>>(
    ({ item, index }) => <TrackRow track={item} index={index} active={item.id === activeTrackId} onPlay={onPlay} />,
    [activeTrackId, onPlay],
  );

  if (search.tooShort) {
    return <CenteredMessage icon="search" title="Ещё немного" text="Введите хотя бы две буквы — и начнём искать." />;
  }
  if (search.loading || (search.typing && tracks.length === 0 && !search.error)) return <SkeletonRows />;
  if (search.error) {
    return (
      <View style={styles.padded}>
        <Notice tone="danger" title="Поиск не ответил">
          Проверьте интернет и попробуйте ещё раз.
        </Notice>
        <Button label="Повторить" variant="secondary" icon="refresh" onPress={search.retry} />
      </View>
    );
  }
  if (tracks.length === 0) {
    return <CenteredMessage icon="search" title="Ничего не нашли" text={`По запросу «${query}» пусто. Попробуйте другое название, артиста или жанр.`} />;
  }
  return (
    <FlatList
      data={tracks}
      keyExtractor={(t, i) => `${t.id}#${i}`}
      renderItem={renderItem}
      extraData={activeTrackId}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.results}
      accessibilityLabel={`Найдено треков: ${tracks.length}`}
    />
  );
}

function Showcase({ activeTrackId }: { activeTrackId: string | null }) {
  const sections = useSections();
  const [pulling, setPulling] = useState(false);

  const { refetch } = sections;
  const onRefresh = useCallback(async () => {
    setPulling(true);
    try {
      await refetch();
    } finally {
      setPulling(false);
    }
  }, [refetch]);

  const onPlay = useCallback((section: Section, index: number) => {
    playFrom(section.tracks, index, { kind: 'section', id: section.id, title: section.title });
  }, []);

  let body: ReactNode;
  if (sections.isPending) {
    body = <SkeletonRails />;
  } else if (sections.isError && !sections.data) {
    body = (
      <View style={styles.padded}>
        <Notice tone="danger" title="Витрина не загрузилась">
          Проверьте интернет и попробуйте ещё раз.
        </Notice>
        <Button label="Повторить" variant="secondary" icon="refresh" onPress={() => void refetch()} />
      </View>
    );
  } else if (!sections.data || sections.data.length === 0) {
    body = (
      <CenteredMessage
        icon="musical-notes-outline"
        title="Здесь пока тихо"
        text="Разделы появятся, как только источники ответят. Потяните экран вниз, чтобы обновить."
      />
    );
  } else {
    body = (
      <View style={styles.rails}>
        {sections.isError ? (
          <View style={styles.padded}>
            <Notice tone="warning" title="Не удалось обновить">
              Показываем то, что загрузили раньше.
            </Notice>
          </View>
        ) : null}
        {sections.data.map((section) => (
          <SectionRail key={section.id} section={section} activeTrackId={activeTrackId} onPlay={onPlay} />
        ))}
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.showcase}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => void onRefresh()}
          tintColor={colors.violet}
          colors={[colors.violet]}
          progressBackgroundColor={colors.surface2}
        />
      }
    >
      {body}
    </ScrollView>
  );
}

export default function MusicScreen() {
  const [query, setQuery] = useState('');
  const search = useSearch(query);
  const activeTrackId = useNowPlaying((s) => s.track?.id ?? null);

  return (
    <Screen edges={['top']} padded={false}>
      <View style={styles.header}>
        <Txt variant="title" accessibilityRole="header">
          Музыка
        </Txt>
        <SearchField value={query} onChange={setQuery} />
      </View>
      <View style={styles.body}>
        {search.active ? <SearchResults search={search} activeTrackId={activeTrackId} /> : <Showcase activeTrackId={activeTrackId} />}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space(5), paddingTop: space(4), paddingBottom: space(3), gap: space(4) },
  body: { flex: 1 },
  search: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingLeft: space(4),
    paddingRight: space(1),
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    minHeight: HIT,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 16,
    paddingVertical: 0,
  },
  showcase: { paddingTop: space(2), paddingBottom: space(10), flexGrow: 1 },
  rails: { gap: space(8) },
  results: { paddingBottom: space(10) },
  padded: { paddingHorizontal: space(5), gap: space(3) },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(3), paddingHorizontal: space(10), paddingVertical: space(12) },
});
