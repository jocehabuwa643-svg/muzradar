import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import { colors } from '@/ui/theme';

export interface RadarSweepProps {
  size: number;
  /** Доступа нет: развёртка гаснет и останавливается — радар «не видит». */
  muted?: boolean;
}

/** Один оборот. Медленно: это фон для первого экрана, а не индикатор загрузки. */
const TURN_MS = 5600;
const WEDGE_DEG = 64;
/** Без анимации клин стоит под углом — статичная картинка всё равно читается как радар. */
const REST_DEG = 38;

/** Другие слушатели — фиксированные точки в долях радиуса и градусах. */
const BLIPS = [
  { r: 0.72, a: -38, s: 3.5 },
  { r: 0.5, a: 118, s: 3 },
  { r: 0.86, a: 204, s: 2.5 },
  { r: 0.62, a: 262, s: 3 },
] as const;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function RadarSweep({ size, muted = false }: RadarSweepProps) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(REST_DEG);
  const animate = !reducedMotion && !muted;

  useEffect(() => {
    if (!animate) {
      cancelAnimation(rotation);
      rotation.value = REST_DEG;
      return;
    }
    rotation.value = withRepeat(withTiming(rotation.value + 360, { duration: TURN_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(rotation);
  }, [animate, rotation]);

  const sweepStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  const c = size / 2;
  const R = c - 1;
  const zoneR = R * 0.3;
  const sweepColor = muted ? colors.textFaint : colors.accent;

  // Клин развёртки: ведущий край смотрит вверх, хвост тянется против часовой стрелки
  const a0 = rad(-90 - WEDGE_DEG);
  const a1 = rad(-90);
  const wedge = `M${c} ${c} L${c + R * Math.cos(a0)} ${c + R * Math.sin(a0)} A${R} ${R} 0 0 1 ${c + R * Math.cos(a1)} ${c + R * Math.sin(a1)} Z`;

  return (
    <View
      style={{ width: size, height: size }}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="radar-floor" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.surface2} stopOpacity={0.9} />
            <Stop offset="1" stopColor={colors.bg} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={c} cy={c} r={R} fill="url(#radar-floor)" />
        {[1, 0.66, 0.33].map((k) => (
          <Circle key={k} cx={c} cy={c} r={R * k} stroke={colors.border} strokeWidth={1} fill="none" />
        ))}
        <Line x1={c - R} y1={c} x2={c + R} y2={c} stroke={colors.border} strokeWidth={1} strokeOpacity={0.6} />
        <Line x1={c} y1={c - R} x2={c} y2={c + R} stroke={colors.border} strokeWidth={1} strokeOpacity={0.6} />
        {BLIPS.map((b) => (
          <Circle
            key={`${b.r}:${b.a}`}
            cx={c + R * b.r * Math.cos(rad(b.a))}
            cy={c + R * b.r * Math.sin(rad(b.a))}
            r={b.s}
            fill={muted ? colors.textFaint : colors.violet}
            fillOpacity={muted ? 0.5 : 0.9}
          />
        ))}
        {/* зона ≈ 1 км: так вас видят другие — не точкой, а кругом */}
        <Circle
          cx={c}
          cy={c}
          r={zoneR}
          fill={muted ? colors.surface3 : colors.accentSoft}
          stroke={muted ? colors.borderStrong : colors.accent}
          strokeOpacity={0.55}
          strokeWidth={1}
          strokeDasharray="3 5"
        />
      </Svg>

      <Animated.View style={[StyleSheet.absoluteFill, sweepStyle]}>
        <Svg width={size} height={size}>
          <Defs>
            <LinearGradient id="radar-sweep" x1={c} y1={c - R * 0.5} x2={c - R * 0.95} y2={c - R * 0.15} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={sweepColor} stopOpacity={muted ? 0.12 : 0.32} />
              <Stop offset="1" stopColor={sweepColor} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <G>
            <Path d={wedge} fill="url(#radar-sweep)" />
            <Line x1={c} y1={c} x2={c} y2={c - R} stroke={sweepColor} strokeWidth={1.5} strokeOpacity={muted ? 0.35 : 0.9} strokeLinecap="round" />
          </G>
        </Svg>
      </Animated.View>

      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={c} cy={c} r={11} fill={muted ? colors.textFaint : colors.accent} fillOpacity={0.18} />
        <Circle cx={c} cy={c} r={5} fill={muted ? colors.textFaint : colors.accent} />
      </Svg>
    </View>
  );
}
