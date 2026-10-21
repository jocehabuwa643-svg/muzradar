import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, HIT, radius, space, typography, type TypographyVariant } from './theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

// ─── Текст ───────────────────────────────────────────────────────────────────

export interface TxtProps extends TextProps {
  variant?: TypographyVariant;
  color?: string;
  align?: TextStyle['textAlign'];
}

export function Txt({ variant = 'body', color = colors.text, align, style, ...rest }: TxtProps) {
  return <Text {...rest} style={[typography[variant], { color, textAlign: align }, style]} />;
}

// ─── Кнопка ──────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Растянуть на всю ширину (по умолчанию да). */
  block?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityHint?: string;
}

const BUTTON_COLORS: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.accent, fg: colors.accentInk, border: colors.accent },
  secondary: { bg: colors.surface2, fg: colors.text, border: colors.border },
  ghost: { bg: colors.transparent, fg: colors.text, border: colors.transparent },
  danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerSoft },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  block = true,
  style,
  testID,
  accessibilityHint,
}: ButtonProps) {
  const palette = BUTTON_COLORS[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        block && styles.block,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <View style={styles.buttonContent}>
          {icon ? <Ionicons name={icon} size={20} color={palette.fg} /> : null}
          <Txt variant="label" color={palette.fg} style={styles.buttonLabel}>
            {label}
          </Txt>
        </View>
      )}
    </Pressable>
  );
}

// ─── Иконка-кнопка ───────────────────────────────────────────────────────────

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  label: string;
  size?: number;
  color?: string;
  filled?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function IconButton({ icon, onPress, label, size = 24, color = colors.text, filled, disabled, testID }: IconButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        filled && { backgroundColor: colors.surface2 },
        { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 },
      ]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </Pressable>
  );
}

// ─── Чип ─────────────────────────────────────────────────────────────────────

export interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  leading?: string;
  tone?: 'accent' | 'violet';
  testID?: string;
}

export function Chip({ label, selected, onToggle, leading, tone = 'accent', testID }: ChipProps) {
  const on = tone === 'accent' ? colors.accent : colors.violet;
  const onSoft = tone === 'accent' ? colors.accentSoft : colors.violetSoft;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      onPress={() => {
        void Haptics.selectionAsync().catch(() => undefined);
        onToggle();
      }}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: selected ? onSoft : colors.surface, borderColor: selected ? on : colors.border },
        pressed && { opacity: 0.75 },
      ]}
    >
      {leading ? <Txt variant="label">{leading}</Txt> : null}
      <Txt variant="label" color={selected ? on : colors.text}>
        {label}
      </Txt>
    </Pressable>
  );
}

// ─── Экран ───────────────────────────────────────────────────────────────────

export interface ScreenProps {
  children: ReactNode;
  /** Липкая зона снизу: основная кнопка шага. */
  footer?: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Screen({ children, footer, scroll = false, edges = ['top', 'bottom'], padded = true, style, testID }: ScreenProps) {
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[padded && styles.padded, styles.grow]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.grow, padded && styles.padded]}>{children}</View>
  );
  return (
    <SafeAreaView testID={testID} edges={edges} style={[styles.screen, style]}>
      {body}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

// ─── Прогресс шагов ──────────────────────────────────────────────────────────

export function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <View
      style={styles.dots}
      accessibilityRole="progressbar"
      accessibilityLabel={`Шаг ${current + 1} из ${total}`}
      accessibilityValue={{ min: 1, max: total, now: current + 1 }}
    >
      {Array.from({ length: total }, (_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            i < current && { backgroundColor: colors.textFaint },
            i === current && { backgroundColor: colors.accent, width: 22 },
          ]}
        />
      ))}
    </View>
  );
}

// ─── Карточка-сообщение ──────────────────────────────────────────────────────

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger'; title: string; children?: ReactNode }) {
  const palette =
    tone === 'danger'
      ? { bg: colors.dangerSoft, fg: colors.danger, icon: 'alert-circle' as const }
      : tone === 'warning'
        ? { bg: 'rgba(255,184,77,0.12)', fg: colors.warning, icon: 'warning' as const }
        : { bg: colors.surface2, fg: colors.textMuted, icon: 'information-circle' as const };
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]} accessibilityRole="alert">
      <Ionicons name={palette.icon} size={20} color={palette.fg} />
      <View style={styles.noticeBody}>
        <Txt variant="label" color={palette.fg}>
          {title}
        </Txt>
        {children ? (
          <Txt variant="caption" color={colors.textMuted}>
            {children}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  grow: { flexGrow: 1 },
  padded: { paddingHorizontal: space(5), paddingTop: space(4) },
  footer: { paddingHorizontal: space(5), paddingTop: space(3), paddingBottom: space(4), gap: space(2) },
  button: {
    minHeight: 56,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: space(6),
    alignItems: 'center',
    justifyContent: 'center',
  },
  block: { alignSelf: 'stretch' },
  buttonContent: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  buttonLabel: { fontSize: 16 },
  iconButton: {
    minWidth: HIT,
    minHeight: HIT,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chip: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingHorizontal: space(4),
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  dots: { flexDirection: 'row', gap: space(1.5), alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.surface3 },
  notice: { flexDirection: 'row', gap: space(3), padding: space(4), borderRadius: radius.md, alignItems: 'flex-start' },
  noticeBody: { flex: 1, gap: space(1) },
});
