import type { Track } from '@muzradar/shared';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Txt } from '@/ui/components';
import { colors, fonts, radius, space } from '@/ui/theme';
import { previewSeconds } from './format';

/** Метка отрывка: слушатель должен понимать, что трек оборвётся не по ошибке. */
export function PreviewBadge({
  track,
  compact = false,
  style,
}: {
  track: Pick<Track, 'playback' | 'previewSec'>;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  if (track.playback !== 'preview') return null;
  const sec = previewSeconds(track);
  return (
    <View style={[styles.badge, compact && styles.compact, style]} accessibilityLabel={`Отрывок ${sec} секунд`}>
      <Txt variant="caption" color={colors.violet} style={styles.text}>
        {compact ? `${sec} с` : `Отрывок ${sec} с`}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: space(2),
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(15,15,23,0.86)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.violet,
  },
  compact: { paddingHorizontal: space(1.5), paddingVertical: 1 },
  text: { fontFamily: fonts.bodySemi },
});
