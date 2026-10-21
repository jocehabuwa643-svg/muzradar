import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { appConfig } from '@/lib/config';
import { Button, Notice, Screen, Txt, type IconName } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';
import { useLocationGate, type LocationGateState } from './gate';

export const LOCATION_REQUIRED_TEXT = 'Без геолокации МУЗРАДАР не работает';

export interface LocationGateCopy {
  /** Что случилось — коротко. */
  title: string;
  /** Что сделать — конкретно, с путём в настройках. */
  reason: string;
  /** Подпись единственной кнопки; null — действовать не нужно. */
  action: string | null;
  icon: IconName;
}

/** Тексты для каждого состояния гейта: общие для шага онбординга и экрана-блокировки. */
export function locationGateCopy(state: LocationGateState, os: string = Platform.OS): LocationGateCopy {
  const ios = os === 'ios';
  switch (state) {
    case 'services_off':
      return {
        title: 'Геолокация на телефоне выключена',
        reason: ios
          ? 'Откройте Настройки → Конфиденциальность и безопасность → Службы геолокации и включите их.'
          : 'Включите её в системном окне — если оно не появится, откроем настройки геолокации.',
        action: ios ? 'Открыть настройки' : 'Включить геолокацию',
        icon: 'navigate-circle-outline',
      };
    case 'undetermined':
      return {
        title: 'Нужен доступ к геолокации',
        reason: 'Выберите «При использовании приложения». В фоне МУЗРАДАР геолокацию не запрашивает.',
        action: 'Разрешить',
        icon: 'location-outline',
      };
    case 'denied_can_ask':
      return {
        title: 'Доступ к геолокации не выдан',
        reason: 'Разрешите доступ «При использовании приложения», чтобы появиться на радаре и видеть слушателей рядом.',
        action: 'Разрешить',
        icon: 'location-outline',
      };
    case 'blocked':
      return {
        title: 'Доступ к геолокации запрещён',
        reason: ios
          ? 'Откройте Настройки → МУЗРАДАР → Геолокация и выберите «При использовании приложения».'
          : 'Откройте настройки → Разрешения → Местоположение и выберите «Разрешить только во время использования».',
        action: 'Открыть настройки',
        icon: 'lock-closed-outline',
      };
    case 'checking':
      return { title: 'Проверяем геолокацию', reason: '', action: null, icon: 'location-outline' };
    case 'ok':
    case 'ok_approx':
      return { title: 'Геолокация доступна', reason: '', action: null, icon: 'location' };
  }
}

/**
 * Глобальный экран-блокировка после онбординга (режим `hard`): доступ к геолокации
 * отозвали или выключили службы. В режиме `map-only` ничего не рисует — карта решает сама,
 * но гейт всё равно проверяется, чтобы сессия знала актуальное состояние.
 */
export function LocationGate() {
  const gate = useLocationGate();
  const [busy, setBusy] = useState(false);
  const blocking = appConfig.locationGate === 'hard' && gate.state !== 'checking' && !gate.ok;

  useEffect(() => {
    // На iOS модальные экраны (плеер) показываются нативно поверх корневого вида —
    // покрытие ниже их не закрывает, поэтому такие экраны сворачиваем.
    if (blocking && Platform.OS === 'ios' && router.canDismiss()) router.dismissAll();
  }, [blocking]);

  if (!blocking) return null;

  const copy = locationGateCopy(gate.state);
  const onPress = async () => {
    setBusy(true);
    try {
      await gate.resolve();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      style={styles.cover}
      accessibilityViewIsModal
      importantForAccessibility="yes"
      testID="location-gate"
    >
      <Screen
        footer={
          copy.action ? <Button label={copy.action} onPress={() => void onPress()} loading={busy} testID="location-gate-action" /> : null
        }
      >
        <View style={styles.body}>
          <View style={styles.badge}>
            <View style={styles.badgeRing} />
            <Ionicons name={copy.icon} size={40} color={colors.warning} />
          </View>
          <Txt variant="title" align="center" accessibilityRole="header">
            {LOCATION_REQUIRED_TEXT}
          </Txt>
          <Notice tone="warning" title={copy.title}>
            {copy.reason}
          </Notice>
          <Txt variant="caption" color={colors.textFaint} align="center" style={styles.note}>
            Слушатели видят вас приблизительно — зоной около 1 км. Точные координаты не покидают телефон.
          </Txt>
        </View>
      </Screen>
    </Animated.View>
  );
}

const BADGE = 112;

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, zIndex: 1000, elevation: 1000, backgroundColor: colors.bg },
  body: { flex: 1, justifyContent: 'center', gap: space(6) },
  badge: {
    width: BADGE,
    height: BADGE,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,184,77,0.08)',
  },
  badgeRing: {
    ...StyleSheet.absoluteFill,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,184,77,0.35)',
    borderStyle: 'dashed',
  },
  note: { paddingHorizontal: space(4) },
});
