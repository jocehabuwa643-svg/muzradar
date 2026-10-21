import { useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, TextInput } from 'react-native';
import Animated from 'react-native-reanimated';
import {
  buildConsentsInput,
  canSubmitConsents,
  checkBirthYear,
  LEGAL_URLS,
  NO_CONSENTS,
  toggleConsent,
  UNDERAGE_MESSAGE,
  type AcceptedAt,
  type ConsentKey,
} from '@/features/onboarding/consent';
import { useLocationGate } from '@/features/location/gate';
import { ConsentItem } from '@/features/onboarding/ConsentItem';
import { consentsSubmitError, useStepNotice, type StepError } from '@/features/onboarding/completion';
import { enterFade, enterUp } from '@/features/onboarding/motion';
import { StepHeader } from '@/features/onboarding/StepHeader';
import { api } from '@/lib/api';
import { useSession } from '@/state/session';
import { Button, Notice, Screen, Txt } from '@/ui/components';
import { colors, fonts, radius, space } from '@/ui/theme';

const ITEMS: { key: ConsentKey; title: string; description: string; linkLabel: string }[] = [
  {
    key: 'processing',
    title: 'Даю согласие на обработку персональных данных',
    description: 'Год рождения, имя, фото и музыкальный вкус — чтобы работал ваш профиль. Отозвать согласие можно в любой момент.',
    linkLabel: 'Текст согласия',
  },
  {
    key: 'dissemination',
    title: 'Даю согласие на распространение моих данных',
    description: 'Другие пользователи увидят: имя, фото, текущий трек и приблизительное местоположение — зону около 1 км.',
    linkLabel: 'Условия распространения',
  },
  {
    key: 'rules',
    title: 'Принимаю правила сообщества',
    description: 'Без травли, угроз и контента, вредящего детям. Жалобы и блокировки работают.',
    linkLabel: 'Правила сообщества',
  },
];

/**
 * Шаг 2 — возраст и согласия. Галочки по умолчанию сняты, время фиксируется в момент отметки.
 * До нажатия «Продолжить» на сервер не уходит ничего: здесь же впервые создаётся аккаунт.
 */
export default function ConsentStep() {
  // гейт перепроверяется и после шага 1: отозванный доступ вернёт на него
  useLocationGate();
  const savedYear = useSession((s) => s.draft.birthYear);
  const [yearText, setYearText] = useState(savedYear ? String(savedYear) : '');
  const [accepted, setAccepted] = useState<AcceptedAt>(NO_CONSENTS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<StepError | null>(null);
  const [ageRejected, setAgeRejected] = useState(false);
  const { notice, dismiss } = useStepNotice('consent');

  const year = checkBirthYear(yearText);
  const underage = ageRejected || year.status === 'underage';
  const canSubmit = !underage && canSubmitConsents(year, accepted);

  const submit = async () => {
    if (year.status !== 'ok') return;
    const input = buildConsentsInput(year.year, accepted);
    if (!input) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.putConsents(input);
      dismiss();
      const session = useSession.getState();
      session.updateDraft({ birthYear: year.year });
      // последним: переключает шаг, экран сразу размонтируется
      session.markConsentsSaved();
    } catch (err) {
      const failure = consentsSubmitError(err);
      if (failure.kind === 'age') setAgeRejected(true);
      else setError(failure);
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      {error ? <Notice tone={error.kind === 'network' ? 'warning' : 'danger'} title={error.message} /> : null}
      {!canSubmit && !underage ? (
        <Txt variant="caption" color={colors.textFaint} align="center">
          {year.status !== 'ok' ? 'Укажите год рождения' : 'Отметьте все три пункта'}
        </Txt>
      ) : null}
      <Button
        label={error?.kind === 'network' ? 'Повторить' : 'Продолжить'}
        onPress={() => void submit()}
        disabled={!canSubmit}
        loading={submitting}
        testID="consent-continue"
      />
    </>
  );

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.flex}>
      <Screen scroll footer={footer} testID="onboarding-consent">
        <StepHeader
          step={1}
          overline="Шаг 2 из 5 · Согласия"
          title="Возраст и согласия"
          subtitle="Каждый пункт — отдельное решение. Пока вы не нажмёте «Продолжить», мы ничего не отправляем."
        />

        {notice ? (
          <Animated.View entering={enterFade()} style={styles.block}>
            <Notice tone="warning" title={notice.title}>
              {notice.text}
            </Notice>
          </Animated.View>
        ) : null}

        <Animated.View entering={enterUp(2)} style={styles.block}>
          <Txt variant="overline" color={colors.textFaint} nativeID="birth-year-label">
            Год рождения
          </Txt>
          <TextInput
            value={yearText}
            onChangeText={(t) => setYearText(t.replace(/\D+/g, '').slice(0, 4))}
            placeholder="2001"
            placeholderTextColor={colors.textFaint}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={4}
            autoComplete="birthdate-year"
            returnKeyType="done"
            editable={!ageRejected && !submitting}
            accessibilityLabel="Год рождения"
            accessibilityLabelledBy="birth-year-label"
            selectionColor={colors.accent}
            style={[styles.yearInput, (year.status === 'invalid' || underage) && styles.inputError]}
            testID="birth-year"
          />
          {year.status === 'invalid' ? (
            <Txt variant="caption" color={colors.danger}>
              {year.message}
            </Txt>
          ) : year.status === 'ok' && year.minor ? (
            <Txt variant="caption" color={colors.textMuted}>
              До 18 лет вас видят только взаимные подписки, а невидимка включена по умолчанию.
            </Txt>
          ) : (
            <Txt variant="caption" color={colors.textFaint}>
              Нужен только год. МУЗРАДАР — с 16 лет.
            </Txt>
          )}
        </Animated.View>

        {underage ? (
          <Animated.View entering={enterFade()} style={styles.block} testID="age-blocked">
            <Notice tone="danger" title={UNDERAGE_MESSAGE}>
              {ageRejected
                ? 'Регистрация недоступна. Когда вам исполнится 16, возвращайтесь.'
                : 'Мы не создаём аккаунты младше 16 лет. Ничего из введённого не отправлено.'}
            </Notice>
          </Animated.View>
        ) : (
          <Animated.View entering={enterUp(3)} style={[styles.block, styles.items]}>
            {ITEMS.map((item) => (
              <ConsentItem
                key={item.key}
                checked={accepted[item.key] !== null}
                onToggle={() => setAccepted((a) => toggleConsent(a, item.key))}
                title={item.title}
                description={item.description}
                linkLabel={item.linkLabel}
                url={LEGAL_URLS[item.key]}
                disabled={submitting}
                testID={`consent-${item.key}`}
              />
            ))}
          </Animated.View>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  block: { marginTop: space(6), gap: space(2) },
  items: { gap: space(3), marginBottom: space(4) },
  yearInput: {
    fontFamily: fonts.display,
    fontSize: 28,
    letterSpacing: 4,
    color: colors.text,
    minHeight: 60,
    paddingHorizontal: space(4),
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  inputError: { borderColor: colors.danger },
});
