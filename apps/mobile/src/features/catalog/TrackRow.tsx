import Ionicons from '@expo/vector-icons/Ionicons';
import type { Track } from '@muzradar/shared';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Txt } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';
import { Artwork } from './Artwork';
import { formatTime, trackA11yLabel } from './format';
import { PreviewBadge } from './PreviewBadge';

export interface TrackRowProps {
  track: Track;
  index: number;
  active: boolean;
  onPlay: (index: number) => void;
}

export const TRACK_ROW_HEIGHT = 68;

export const TrackRow = memo(function TrackRow({ track, index, active, onPlay }: TrackRowProps) {
  return (
    <Pressable
      onPress={() => onPlay(index)}
      accessibilityRole="button"
      accessibilityLabel={trackA11yLabel(track)}
      accessibilityHint={active ? 'Сейчас играет' : 'Включить трек'}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Artwork uri={track.artworkUrl} size={52} radius={radius.sm} />
      <View style={styles.meta}>
        <Txt variant="bodyStrong" numberOfLines={1} color={active ? colors.violet : colors.text}>
          {track.title}
        </Txt>
        <Txt variant="caption" numberOfLines={1} color={colors.textMuted}>
          {track.artist}
        </Txt>
      </View>
      <View style={styles.trailing}>
        {active ? <Ionicons name="volume-high" size={18} color={colors.violet} /> : null}
        {track.playback === 'preview' ? (
          <PreviewBadge track={track} compact />
        ) : track.durationSec > 0 ? (
          <Txt variant="caption" color={colors.textFaint}>
            {formatTime(track.durationSec)}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: TRACK_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(5),
    paddingVertical: space(2),
  },
  pressed: { backgroundColor: colors.surface },
  meta: { flex: 1, gap: 2 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
});
