import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { formatSpokenTime, formatTime } from '@/features/catalog/format';
import { Txt } from '@/ui/components';
import { colors, HIT } from '@/ui/theme';

const THUMB = 14;
/** Шаг перемотки для экранного диктора (свайп вверх/вниз на ползунке). */
const A11Y_STEP_SEC = 10;

function clamp01(v: number): number {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface SeekBarProps {
  positionSec: number;
  durationSec: number;
  onSeek: (sec: number) => void;
  disabled?: boolean;
}

/**
 * Ползунок перемотки: жест и отрисовка на UI-потоке, в JS — только итоговая позиция
 * и секунды для подписи (не чаще раза в секунду).
 */
export function SeekBar({ positionSec, durationSec, onSeek, disabled = false }: SeekBarProps) {
  const reduceMotion = useReducedMotion();
  const duration = durationSec > 0 ? durationSec : 0;
  const canSeek = !disabled && duration > 0;

  const width = useSharedValue(0);
  const progress = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragProgress = useSharedValue(0);
  const lastDragSec = useSharedValue(-1);
  const [dragSec, setDragSec] = useState<number | null>(null);

  useEffect(() => {
    progress.value = duration > 0 ? clamp01(positionSec / duration) : 0;
  }, [positionSec, duration, progress]);

  const commit = useCallback(
    (sec: number) => {
      setDragSec(null);
      onSeek(sec);
    },
    [onSeek],
  );

  // позиция обновляется дважды в секунду — жесты пересобираем только при смене длительности
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(canSeek)
      .activeOffsetX([-6, 6])
      // вертикальный свайп отдаём модальному окну — им плеер закрывают
      .failOffsetY([-14, 14])
      .onStart((e) => {
        dragging.value = true;
        dragProgress.value = clamp01(e.x / Math.max(1, width.value));
      })
      .onUpdate((e) => {
        dragProgress.value = clamp01(e.x / Math.max(1, width.value));
        const sec = Math.round(dragProgress.value * duration);
        if (sec !== lastDragSec.value) {
          lastDragSec.value = sec;
          scheduleOnRN(setDragSec, sec);
        }
      })
      .onEnd(() => {
        progress.value = dragProgress.value;
        scheduleOnRN(commit, dragProgress.value * duration);
      })
      .onFinalize(() => {
        dragging.value = false;
        lastDragSec.value = -1;
      });

    const tap = Gesture.Tap()
      .enabled(canSeek)
      .onEnd((e) => {
        const p = clamp01(e.x / Math.max(1, width.value));
        progress.value = p;
        scheduleOnRN(commit, p * duration);
      });

    return Gesture.Race(pan, tap);
  }, [canSeek, duration, commit, width, progress, dragging, dragProgress, lastDragSec]);

  const fillStyle = useAnimatedStyle(() => ({
    width: (dragging.value ? dragProgress.value : progress.value) * width.value,
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: (dragging.value ? dragProgress.value : progress.value) * width.value - THUMB / 2 },
      { scale: withTiming(dragging.value ? 1.4 : 1, { duration: reduceMotion ? 0 : 140 }) },
    ],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  const shownSec = dragSec ?? positionSec;
  const remaining = Math.max(0, duration - shownSec);

  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (!canSeek) return;
    const delta = e.nativeEvent.actionName === 'increment' ? A11Y_STEP_SEC : e.nativeEvent.actionName === 'decrement' ? -A11Y_STEP_SEC : 0;
    if (delta !== 0) onSeek(Math.min(duration, Math.max(0, positionSec + delta)));
  };

  return (
    <View style={styles.wrap}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Позиция в треке"
        accessibilityState={{ disabled: !canSeek }}
        accessibilityValue={{
          min: 0,
          max: Math.round(duration),
          now: Math.round(Math.min(positionSec, duration)),
          text: `${formatSpokenTime(positionSec)} из ${formatSpokenTime(duration)}`,
        }}
        accessibilityActions={[
          { name: 'increment', label: 'Вперёд на 10 секунд' },
          { name: 'decrement', label: 'Назад на 10 секунд' },
        ]}
        onAccessibilityAction={onAccessibilityAction}
      >
        <GestureDetector gesture={gesture}>
          <View style={styles.hitArea} onLayout={onLayout}>
            <View style={styles.track}>
              <Animated.View style={[styles.fill, fillStyle]} />
            </View>
            {canSeek ? <Animated.View style={[styles.thumb, thumbStyle]} /> : null}
          </View>
        </GestureDetector>
      </View>
      <View style={styles.times} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Txt variant="caption" color={dragSec !== null ? colors.text : colors.textMuted} style={styles.tabular}>
          {formatTime(shownSec)}
        </Txt>
        <Txt variant="caption" color={colors.textMuted} style={styles.tabular}>
          {duration > 0 ? `−${formatTime(remaining)}` : '−:−−'}
        </Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 2 },
  hitArea: { height: HIT, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surface3, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.violet },
  thumb: {
    position: 'absolute',
    left: 0,
    top: (HIT - THUMB) / 2,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: colors.text,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between' },
  tabular: { fontVariant: ['tabular-nums'] },
});
