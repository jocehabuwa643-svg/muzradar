import Ionicons from '@expo/vector-icons/Ionicons';
import type { Section, Track } from '@muzradar/shared';
import { memo, useCallback } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';
import { Txt } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';
import { TRACK_CARD_WIDTH, TrackCard } from './TrackCard';

export interface SectionRailProps {
  section: Section;
  /** id трека, который сейчас в плеере. */
  activeTrackId: string | null;
  onPlay: (section: Section, index: number) => void;
}

const GAP = space(3);

function Separator() {
  return <View style={{ width: GAP }} />;
}

/** Пометка сервера на месте ленты: раздел не исчезает молча, а честно говорит, почему он пуст. */
function SectionNotice({ text }: { text: string }) {
  return (
    <View style={styles.notice}>
      <Ionicons name="information-circle-outline" size={20} color={colors.violet} />
      <Txt variant="caption" color={colors.textMuted} style={styles.noticeText}>
        {text}
      </Txt>
    </View>
  );
}

export const SectionRail = memo(function SectionRail({ section, activeTrackId, onPlay }: SectionRailProps) {
  const play = useCallback((index: number) => onPlay(section, index), [onPlay, section]);
  const renderItem = useCallback<ListRenderItem<Track>>(
    ({ item, index }) => <TrackCard track={item} index={index} active={item.id === activeTrackId} onPlay={play} />,
    [activeTrackId, play],
  );

  return (
    <View style={styles.section}>
      <View style={styles.header} accessibilityRole="header">
        <Txt variant="heading">{section.title}</Txt>
        {section.subtitle ? (
          <Txt variant="caption" color={colors.textMuted} numberOfLines={2}>
            {section.subtitle}
          </Txt>
        ) : null}
      </View>
      {section.notice ? <SectionNotice text={section.notice} /> : null}
      {section.tracks.length > 0 ? (
        <FlatList
          horizontal
          data={section.tracks}
          keyExtractor={(t, i) => `${t.id}#${i}`}
          renderItem={renderItem}
          extraData={activeTrackId}
          ItemSeparatorComponent={Separator}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.list}
          initialNumToRender={4}
          windowSize={5}
          getItemLayout={(_, index) => ({ length: TRACK_CARD_WIDTH + GAP, offset: (TRACK_CARD_WIDTH + GAP) * index, index })}
          accessibilityLabel={`${section.title}: ${section.tracks.length} треков`}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  section: { gap: space(3) },
  header: { paddingHorizontal: space(5), gap: 2 },
  list: { paddingHorizontal: space(5) },
  notice: {
    marginHorizontal: space(5),
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space(3),
    padding: space(4),
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  noticeText: { flex: 1 },
});
