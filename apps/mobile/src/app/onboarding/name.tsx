import Ionicons from '@expo/vector-icons/Ionicons';
import { DisplayName, LIMITS } from '@muzradar/shared';
import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocationGate } from '@/features/location/gate';
import { useStepNotice } from '@/features/onboarding/completion';
import { enterFade, enterUp } from '@/features/onboarding/motion';
import { StepHeader } from '@/features/onboarding/StepHeader';
import { useSession } from '@/state/session';
import { Button, Notice, Screen, Txt } from '@/ui/components';
import { colors, fonts, radius, space } from '@/ui/theme';

type NameCheck = { ok: true; name: string } | { ok: false; message: string; /** Просто ещё не дописали — не ошибка. */ soft: boolean };

function checkName(value: string): NameCheck {
  const parsed = DisplayName.safeParse(value);
  if (parsed.success) return { ok: true, name: parsed.data };
  const issues = parsed.error.issues;
  const soft = value.trim() === '' || issues.every((i) => i.code === 'too_small');
  return { ok: false, message: value.trim() === '' ? 'Буквы, цифры, пробел и - _ .' : (issues[0]?.message ?? 'Проверьте имя'), soft };
}

/** Шаг 3 — имя. Решение о допустимости — за сервером; здесь только подсказка по схеме. */
export default function NameStep() {
  useLocationGate();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const { notice, dismiss } = useStepNotice('name');
  const check = checkName(value);
  const length = value.trim().length;
  const showError = !check.ok && !check.soft;

  const submit = () => {
    if (!check.ok) {
      setTouched(true);
      return;
    }
    dismiss();
    useSession.getState().updateDraft({ name: check.name });
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.flex}>
      <Screen
        scroll
        footer={<Button label="Продолжить" onPress={submit} disabled={!check.ok} testID="name-continue" />}
        testID="onboarding-name"
      >
        <StepHeader
          step={2}
          overline="Шаг 3 из 5 · Имя"
          title="Как вас зовут на радаре?"
          subtitle="Имя увидят слушатели рядом. Можно ник — главное, без ссылок и оскорблений."
        />

        {notice ? (
          <Animated.View entering={enterFade()} style={styles.block}>
            <Notice tone="danger" title={notice.title}>
              {notice.text}
            </Notice>
          </Animated.View>
        ) : null}

        <Animated.View entering={enterUp(2)} style={styles.block}>
          <TextInput
            value={value}
            onChangeText={setValue}
            onBlur={() => setTouched(true)}
            onSubmitEditing={submit}
            placeholder="Например, Лиза"
            placeholderTextColor={colors.textFaint}
            autoFocus
            autoCapitalize="words"
            autoCorrect={false}
            autoComplete="off"
            maxLength={LIMITS.nameMax}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            accessibilityLabel="Имя на радаре"
            accessibilityHint={`От ${LIMITS.nameMin} до ${LIMITS.nameMax} символов`}
            selectionColor={colors.accent}
            style={[styles.input, (showError || (touched && !check.ok && length > 0)) && styles.inputError]}
            testID="name-input"
          />
          <View style={styles.meta}>
            <Txt
              variant="caption"
              color={showError ? colors.danger : colors.textFaint}
              style={styles.metaText}
              accessibilityLiveRegion="polite"
            >
              {check.ok ? 'Подходит' : check.message}
            </Txt>
            <Txt variant="caption" color={length > LIMITS.nameMax ? colors.danger : colors.textFaint}>
              {`${value.length}/${LIMITS.nameMax}`}
            </Txt>
          </View>
        </Animated.View>

        <Animated.View entering={enterUp(3)} style={styles.previewWrap}>
          <Txt variant="overline" color={colors.textFaint}>
            Так вас увидят на карте
          </Txt>
          <View style={styles.marker} accessibilityLabel={`Метка на карте: ${check.ok ? check.name : 'ваше имя'}`}>
            <View style={styles.markerAvatar}>
              <Ionicons name="person" size={18} color={colors.textFaint} />
            </View>
            <View style={styles.markerText}>
              <Txt variant="label" numberOfLines={1}>
                {check.ok ? check.name : 'Ваше имя'}
              </Txt>
              <Txt variant="caption" color={colors.violet} numberOfLines={1}>
                ♪ сейчас играет
              </Txt>
            </View>
          </View>
        </Animated.View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  block: { marginTop: space(6), gap: space(2) },
  input: {
    fontFamily: fonts.displayMedium,
    fontSize: 22,
    color: colors.text,
    minHeight: 60,
    paddingHorizontal: space(4),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  inputError: { borderColor: colors.danger },
  meta: { flexDirection: 'row', alignItems: 'flex-start', gap: space(3) },
  metaText: { flex: 1 },
  previewWrap: { marginTop: space(10), gap: space(3), alignItems: 'flex-start' },
  marker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2.5),
    paddingVertical: space(1.5),
    paddingLeft: space(1.5),
    paddingRight: space(4),
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: '100%',
  },
  markerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerText: { flexShrink: 1 },
});
