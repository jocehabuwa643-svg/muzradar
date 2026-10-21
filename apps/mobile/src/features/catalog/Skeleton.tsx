import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, radius, space } from '@/ui/theme';
import { TRACK_CARD_WIDTH } from './TrackCard';
import { TRACK_ROW_HEIGHT } from './TrackRow';

/** Мягкое «дыхание» заглушек; при уменьшении движения — статичная заглушка. */
function usePulse() {
  const reduce = useReducedMotion();
  const opacity = useSharedValue(0.55);
  useEffect(() => {
    if (reduce) return;
    opacity.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(opacity);
  }, [reduce, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

function Block({ style }: { style: StyleProp<ViewStyle> }) {
  return <View style={[styles.block, style]} />;
}

export function SkeletonRails({ count = 3 }: { count?: number }) {
  const pulse = usePulse();
  return (
    <Animated.View style={[styles.rails, pulse]} accessibilityRole="progressbar" accessibilityLabel="Загружаем витрину">
      {Array.from({ length: count }, (_, r) => (
        <View key={r} style={styles.rail}>
          <Block style={styles.title} />
          <View style={styles.cards}>
            {Array.from({ length: 3 }, (_, c) => (
              <View key={c} style={styles.card}>
                <Block style={styles.art} />
                <Block style={styles.line} />
                <Block style={styles.lineShort} />
              </View>
            ))}
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

export function SkeletonRows({ count = 6 }: { count?: number }) {
  const pulse = usePulse();
  return (
    <Animated.View style={pulse} accessibilityRole="progressbar" accessibilityLabel="Ищем треки">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <Block style={styles.rowArt} />
          <View style={styles.rowMeta}>
            <Block style={styles.line} />
            <Block style={styles.lineShort} />
          </View>
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.surface2, borderRadius: radius.sm },
  rails: { gap: space(8), paddingTop: space(2) },
  rail: { gap: space(3) },
  title: { width: 160, height: 20, marginHorizontal: space(5) },
  cards: { flexDirection: 'row', gap: space(3), paddingHorizontal: space(5), overflow: 'hidden' },
  card: { width: TRACK_CARD_WIDTH, gap: space(2) },
  art: { width: TRACK_CARD_WIDTH, height: TRACK_CARD_WIDTH, borderRadius: radius.md },
  line: { height: 12, width: '85%' },
  lineShort: { height: 10, width: '55%' },
  row: {
    height: TRACK_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(5),
  },
  rowArt: { width: 52, height: 52 },
  rowMeta: { flex: 1, gap: space(2) },
});
