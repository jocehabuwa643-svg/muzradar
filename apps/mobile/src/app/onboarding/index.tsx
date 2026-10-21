import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { LOCATION_REQUIRED_TEXT, locationGateCopy } from '@/features/location/LocationGate';
import { useLocationGate } from '@/features/location/gate';
import { enterFade, enterUp } from '@/features/onboarding/motion';
import { RadarSweep } from '@/features/onboarding/RadarSweep';
import { ONBOARDING_TOTAL } from '@/features/onboarding/StepHeader';
import { Button, Notice, Screen, StepDots, Txt, type IconName } from '@/ui/components';
import { colors, fonts, radius, space } from '@/ui/theme';

const ACTION_HINTS: Partial<Record<string, string>> = {
  undetermined: 'Откроет системный запрос доступа к геолокации',
  denied_can_ask: 'Откроет системный запрос доступа к геолокации',
  blocked: 'Откроет настройки приложения',
  services_off: 'Откроет системное окно или настройки геолокации',
};

const FACTS: { icon: IconName; text: string }[] = [
  { icon: 'scan-circle-outline', text: 'Другие видят не точку, а зону около 1 км' },
  { icon: 'phone-portrait-outline', text: 'Точные координаты не покидают телефон' },
  { icon: 'moon-outline', text: 'В фоне геолокацию не запрашиваем' },
];

/**
 * Шаг 1 — геолокация. Кнопку «Дальше» не рисуем: как только гейт пропускает (в том числе
 * с приблизительной геолокацией), session.locationGranted переключается и guard уводит на согласия.
 */
export default function LocationStep() {
  const gate = useLocationGate();
  const [busy, setBusy] = useState(false);
  const { width } = useWindowDimensions();
  const radarSize = Math.min(width - space(20), 240);

  const copy = locationGateCopy(gate.state);
  const problem = gate.state === 'services_off' || gate.state === 'denied_can_ask' || gate.state === 'blocked';
  const checking = gate.state === 'checking';

  const onPress = async () => {
    setBusy(true);
    try {
      await gate.resolve();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      scroll
      footer={
        <Button
          label={copy.action ?? 'Разрешить'}
          icon={gate.state === 'blocked' || gate.state === 'services_off' ? 'settings-outline' : 'navigate'}
          // ok: guard вот-вот уведёт на следующий шаг — кнопка уже не нужна
          loading={busy || checking || gate.ok}
          onPress={() => void onPress()}
          accessibilityHint={ACTION_HINTS[gate.state]}
          testID="location-step-action"
        />
      }
      testID="onboarding-location"
    >
      <Animated.View entering={enterUp(0)}>
        <StepDots total={ONBOARDING_TOTAL} current={0} />
      </Animated.View>

      <View style={styles.hero}>
        <Animated.View entering={enterFade(600)}>
          <RadarSweep size={radarSize} muted={problem} />
        </Animated.View>
        <Animated.View entering={enterUp(1)} style={styles.brand}>
          <Txt style={styles.wordmark} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit>
            МУЗРАДАР
          </Txt>
          <Txt variant="heading" color={colors.textMuted} align="center">
            Слушай тех, кто рядом
          </Txt>
        </Animated.View>
      </View>

      <Animated.View entering={enterUp(2)} style={styles.explain}>
        <Txt variant="bodyStrong">
          Геолокация нужна, чтобы поставить вас на радар и показать, что слушают по соседству.
        </Txt>
        <View style={styles.facts}>
          {FACTS.map((f) => (
            <View key={f.icon} style={styles.fact}>
              <Ionicons name={f.icon} size={20} color={colors.textMuted} />
              <Txt variant="label" color={colors.textMuted} style={styles.factText}>
                {f.text}
              </Txt>
            </View>
          ))}
        </View>
      </Animated.View>

      {problem ? (
        <Animated.View entering={enterFade()} style={styles.warning}>
          <Notice tone="warning" title={LOCATION_REQUIRED_TEXT}>
            {`${copy.title}. ${copy.reason}`}
          </Notice>
        </Animated.View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space(6), paddingTop: space(8), paddingBottom: space(8) },
  brand: { alignItems: 'center', gap: space(2) },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: 36,
    lineHeight: 42,
    letterSpacing: 1.5,
    color: colors.text,
    textAlign: 'center',
  },
  explain: {
    gap: space(4),
    padding: space(5),
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  facts: { gap: space(3) },
  fact: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  factText: { flex: 1 },
  warning: { marginTop: space(4), marginBottom: space(2) },
});
