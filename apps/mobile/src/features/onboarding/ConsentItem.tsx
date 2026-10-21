import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Txt } from '@/ui/components';
import { colors, HIT, radius, space } from '@/ui/theme';

export interface ConsentItemProps {
  checked: boolean;
  onToggle: () => void;
  title: string;
  description: string;
  linkLabel: string;
  url: string;
  disabled?: boolean;
  testID?: string;
}

const BOX = 24;

/**
 * Отдельная галочка согласия: по 152-ФЗ каждое согласие — самостоятельное действие,
 * поэтому у каждой своя строка, свой документ и никакой «отметить всё».
 */
export function ConsentItem({ checked, onToggle, title, description, linkLabel, url, disabled, testID }: ConsentItemProps) {
  return (
    <View style={[styles.card, checked && styles.cardOn]}>
      <Pressable
        testID={testID}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: Boolean(disabled) }}
        accessibilityLabel={title}
        accessibilityHint={description}
        disabled={disabled}
        onPress={() => {
          void Haptics.selectionAsync().catch(() => undefined);
          onToggle();
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
      >
        <View style={[styles.box, checked && styles.boxOn]}>
          {checked ? <Ionicons name="checkmark" size={18} color={colors.accentInk} /> : null}
        </View>
        <View style={styles.text}>
          <Txt variant="label">{title}</Txt>
          <Txt variant="caption" color={colors.textMuted}>
            {description}
          </Txt>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${linkLabel}, откроется в браузере`}
        onPress={() => void Linking.openURL(url).catch(() => undefined)}
        hitSlop={4}
        style={({ pressed }) => [styles.link, pressed && styles.pressed]}
      >
        <Txt variant="label" color={colors.violet}>
          {linkLabel}
        </Txt>
        <Ionicons name="open-outline" size={16} color={colors.violet} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: space(4),
    paddingTop: space(3),
  },
  cardOn: { borderColor: colors.borderStrong },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3), minHeight: HIT, paddingVertical: space(1) },
  box: {
    width: BOX,
    height: BOX,
    marginTop: 1,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  text: { flex: 1, gap: space(1) },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    alignSelf: 'flex-start',
    minHeight: HIT,
    marginLeft: BOX + space(3),
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
});
