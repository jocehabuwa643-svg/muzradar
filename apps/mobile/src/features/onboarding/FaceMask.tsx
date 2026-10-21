import { StyleSheet } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '@/ui/theme';

export interface MaskCircle {
  cx: number;
  cy: number;
  r: number;
}

/**
 * Круг под лицо. Центр на 45 % высоты — как в проверке кадра (faceCheck): превью камеры
 * заполняет экран по высоте, поэтому вертикаль экрана совпадает с вертикалью снимка.
 */
export function maskCircle(width: number, height: number): MaskCircle {
  const r = Math.min(width * 0.37, height * 0.28, 170);
  return { cx: width / 2, cy: height * 0.45, r };
}

export function FaceMask({
  width,
  height,
  circle,
  tone = 'idle',
}: {
  width: number;
  height: number;
  circle: MaskCircle;
  tone?: 'idle' | 'warning';
}) {
  const { cx, cy, r } = circle;
  // Прямоугольник с круглой дырой: even-odd вырезает круг из затемнения
  const d = `M0 0H${width}V${height}H0Z M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0Z`;
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={d} fill={colors.overlay} fillRule="evenodd" />
      <Circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={tone === 'warning' ? colors.warning : colors.text}
        strokeOpacity={tone === 'warning' ? 1 : 0.85}
        strokeWidth={2}
      />
      <Circle cx={cx} cy={cy} r={r + 8} fill="none" stroke={colors.text} strokeOpacity={0.14} strokeWidth={1} strokeDasharray="2 6" />
    </Svg>
  );
}
