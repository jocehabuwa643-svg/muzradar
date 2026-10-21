import Ionicons from '@expo/vector-icons/Ionicons';
import type { Track } from '@muzradar/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';
import { Artwork } from './Artwork';
import { trackA11yLabel } from './format';
import { PreviewBadge } from './PreviewBadge';

export const TRACK_CARD_WIDTH = 148;

export interface TrackCardProps {
  track: Track;
  index: number;
  /** Этот трек сейчас в плеере. */
  active: boolean;
  onPlay: (index: number) => void;
}

export const TrackCard = memo(function TrackCard({ track, index, active, onPlay }: TrackCardProps) {
  return (
    <Pressable
      onPress={() => onPlay(index)}
      accessibilityRole="button"
      accessibilityLabel={trackA11yLabel(track)}
      accessibilityHint={active ? 'Сейчас играет' : 'Включить трек'}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View>
        <Artwork
          uri={track.artworkUrl}
          size={TRACK_CARD_WIDTH}
          radius={radius.md}
          style={active ? styles.activeArt : undefined}
        />
        {active ? (
          <View style={styles.nowBadge}>
            <Ionicons name="volume-high" size={14} color={colors.accentInk} />
          </View>
        ) : null}
        <PreviewBadge track={track} compact style={styles.preview} />
      </View>
      <View style={styles.meta}>
        <Txt variant="label" numberOfLines={1} color={active ? colors.violet : colors.text}>
          {track.title}
        </Txt>
        <Txt variant="caption" numberOfLines={1} color={colors.textMuted}>
          {track.artist}
        </Txt>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { width: TRACK_CARD_WIDTH, gap: space(2) },
  pressed: { opacity: 0.82, transform: [{ scale: 0.98 }] },
  activeArt: { borderWidth: 2, borderColor: colors.violet },
  meta: { gap: 2 },
  nowBadge: {
    position: 'absolute',
    top: space(2),
    left: space(2),
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.violet,
  },
  preview: { position: 'absolute', right: space(2), bottom: space(2) },
});
