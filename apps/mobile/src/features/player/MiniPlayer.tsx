import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Artwork } from '@/features/catalog/Artwork';
import { hasStreamableAfter } from '@/features/catalog/playable';
import { PreviewBadge } from '@/features/catalog/PreviewBadge';
import { IconButton, Txt } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';
import { controller } from './controller';
import { useNowPlayingStore } from './state';

/** Тонкая линия прогресса: подписана на позицию отдельно, чтобы строка не перерисовывалась дважды в секунду. */
function MiniProgress() {
  const fraction = useNowPlayingStore((s) => (s.durationSec > 0 ? Math.min(1, Math.max(0, s.positionSec / s.durationSec)) : 0));
  return (
    <View style={styles.progressTrack} accessible={false} importantForAccessibility="no-hide-descendants">
      <View style={[styles.progressFill, { width: `${fraction * 100}%` }]} />
    </View>
  );
}

/** Мини-плеер над таб-баром; скрыт, пока ничего не выбрано. */
export function MiniPlayer() {
  const { track, playing, hasNext } = useNowPlayingStore((s) => ({
    track: s.track,
    playing: s.playing,
    hasNext: hasStreamableAfter(s.queue, s.index),
  }));
  if (!track) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <View style={styles.row}>
          <Pressable
            onPress={() => router.push('/player')}
            accessibilityRole="button"
            accessibilityLabel={`Сейчас играет: ${track.title}, ${track.artist}`}
            accessibilityHint="Открыть плеер"
            style={({ pressed }) => [styles.open, pressed && styles.pressed]}
          >
            <Artwork uri={track.artworkUrl} size={44} radius={radius.sm} />
            <View style={styles.meta}>
              <Txt variant="label" numberOfLines={1}>
                {track.title}
              </Txt>
              <View style={styles.subline}>
                <PreviewBadge track={track} compact />
                <Txt variant="caption" color={colors.textMuted} numberOfLines={1} style={styles.artist}>
                  {track.artist}
                </Txt>
              </View>
            </View>
          </Pressable>
          <IconButton
            icon={playing ? 'pause' : 'play'}
            label={playing ? 'Пауза' : 'Играть'}
            onPress={controller.toggle}
            size={26}
          />
          <IconButton icon="play-skip-forward" label="Следующий трек" onPress={controller.next} disabled={!hasNext} size={22} />
        </View>
        <MiniProgress />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space(2), paddingTop: space(2) },
  card: {
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: space(1) },
  open: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(3), paddingLeft: space(2), paddingVertical: space(2), minHeight: 60 },
  pressed: { opacity: 0.75 },
  meta: { flex: 1, gap: 2 },
  subline: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  artist: { flexShrink: 1 },
  progressTrack: { height: 2, backgroundColor: colors.surface3 },
  progressFill: { height: 2, backgroundColor: colors.violet },
});
