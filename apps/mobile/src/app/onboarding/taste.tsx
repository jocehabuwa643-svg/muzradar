import { GENRES, LIMITS, MOODS, type GenreId } from '@muzradar/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocationGate } from '@/features/location/gate';
import {
  readMissingSteps,
  rejectName,
  requestErrorMessage,
  rewindToMissingSteps,
} from '@/features/onboarding/completion';
import { enterFade, enterUp } from '@/features/onboarding/motion';
import { StepHeader } from '@/features/onboarding/StepHeader';
import {
  ADD_ARTIST_ERRORS,
  addArtist,
  checkTaste,
  hasArtist,
  tasteFromDraft,
  toggleArtist,
  toggleGenre,
  toggleMood,
  type TasteDraft,
} from '@/features/onboarding/taste';
import { ApiError, api, NetworkError } from '@/lib/api';
import { useSession } from '@/state/session';
import { Button, Chip, IconButton, Notice, Screen, Txt } from '@/ui/components';
import { colors, fonts, HIT, radius, space } from '@/ui/theme';

type SubmitError = { kind: 'network' | 'server'; message: string };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Шаг 5 — музыкальный вкус и завершение онбординга. Черновик вкуса живёт в сессии,
 * поэтому выбор переживает перезапуск и сетевую ошибку на «Выйти в эфир».
 */
export default function TasteStep() {
  useLocationGate();
  const stored = useSession((s) => s.draft.taste);
  const name = useSession((s) => s.draft.name);
  const draft = useMemo(() => tasteFromDraft(stored), [stored]);
  const check = checkTaste(draft);

  const [artistInput, setArtistInput] = useState('');
  const [artistError, setArtistError] = useState<string | null>(null);
  const [genreLimitHit, setGenreLimitHit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SubmitError | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const save = (patch: Partial<TasteDraft>) => {
    useSession.getState().updateDraft({ taste: { ...draft, ...patch } });
  };

  // Подсказки артистов — по выбранным жанрам, с паузой, чтобы серия тапов не рождала серию запросов
  const genresKey = useDebounced([...draft.genres].sort().join(','), 450);
  const suggestions = useQuery({
    queryKey: ['onboarding', 'artists', genresKey],
    queryFn: ({ signal }) => api.artists(genresKey.split(',') as GenreId[], signal),
    enabled: genresKey.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });

  const artistChips = useMemo(() => {
    const suggested: string[] = [];
    for (const a of suggestions.data?.artists ?? []) {
      if (!hasArtist(suggested, a.name)) suggested.push(a.name);
    }
    // свои (добавленные вручную или из прошлых подсказок) — первыми, чтобы выбор не терялся
    return [...draft.artists.filter((a) => !hasArtist(suggested, a)), ...suggested];
  }, [suggestions.data, draft.artists]);

  const onGenre = (id: GenreId) => {
    const r = toggleGenre(draft.genres, id);
    setGenreLimitHit(r.limited);
    if (!r.limited) save({ genres: r.next });
  };

  const onArtistChip = (artist: string) => {
    const r = toggleArtist(draft.artists, artist);
    setArtistError(r.error ? ADD_ARTIST_ERRORS[r.error] : null);
    if (!r.error) save({ artists: r.next });
  };

  const onAddArtist = () => {
    const r = addArtist(draft.artists, artistInput);
    if (r.error) {
      setArtistError(ADD_ARTIST_ERRORS[r.error]);
      return;
    }
    setArtistError(null);
    setArtistInput('');
    save({ artists: r.next });
  };

  const finish = async () => {
    if (!check.taste || !name) return;
    setSubmitting(true);
    setError(null);
    try {
      // успех: api применит профиль с onboardedAt, и корневой guard сам переключит на приложение
      await api.putProfile({ name, taste: check.taste });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'onboarding_incomplete') {
        if (rewindToMissingSteps(readMissingSteps(err.details))) return;
      }
      if (err instanceof ApiError && err.status === 422 && err.code === 'name_rejected') {
        rejectName(err.message);
        return;
      }
      setError({ kind: err instanceof NetworkError ? 'network' : 'server', message: requestErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    <>
      {error ? <Notice tone={error.kind === 'network' ? 'warning' : 'danger'} title={error.message} /> : null}
      {check.hint ? (
        <Txt variant="caption" color={colors.textFaint} align="center">
          {check.hint}
        </Txt>
      ) : null}
      <Button
        label={error?.kind === 'network' ? 'Повторить' : 'Выйти в эфир'}
        icon="radio-outline"
        onPress={() => void finish()}
        disabled={!check.taste}
        loading={submitting}
        testID="taste-finish"
      />
    </>
  );

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.flex}>
      <Screen padded={false} footer={footer} testID="onboarding-taste">
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <StepHeader
            step={4}
            overline="Шаг 5 из 5 · Вкус"
            title="Что вы слушаете?"
            subtitle="По вкусу соберём витрину и подсветим на радаре тех, кто слушает похожее."
          />

          <Animated.View entering={enterUp(2)} style={styles.section}>
            <SectionHead
              title="Жанры"
              rule={`от ${LIMITS.tasteGenresMin} до ${LIMITS.tasteGenresMax}`}
              count={check.genres.count}
              max={LIMITS.tasteGenresMax}
              ok={check.genres.ok}
            />
            <View style={styles.chips}>
              {GENRES.map((g) => (
                <Chip key={g.id} label={g.label} selected={draft.genres.includes(g.id)} onToggle={() => onGenre(g.id)} testID={`genre-${g.id}`} />
              ))}
            </View>
            {genreLimitHit ? (
              <Animated.View entering={enterFade()}>
                <Txt variant="caption" color={colors.warning}>
                  {`Можно выбрать до ${LIMITS.tasteGenresMax} жанров — снимите лишний.`}
                </Txt>
              </Animated.View>
            ) : null}
          </Animated.View>

          <Animated.View entering={enterUp(3)} style={styles.section}>
            <SectionHead title="Настроение" rule="хотя бы одно" count={check.moods.count} max={MOODS.length} ok={check.moods.ok} />
            <View style={styles.chips}>
              {MOODS.map((m) => (
                <Chip
                  key={m.id}
                  label={m.label}
                  leading={m.emoji}
                  tone="violet"
                  selected={draft.moods.includes(m.id)}
                  onToggle={() => save({ moods: toggleMood(draft.moods, m.id) })}
                  testID={`mood-${m.id}`}
                />
              ))}
            </View>
          </Animated.View>

          <Animated.View entering={enterUp(4)} style={styles.section}>
            <SectionHead
              title="Артисты"
              rule={`от ${LIMITS.tasteArtistsMin} до ${LIMITS.tasteArtistsMax}`}
              count={check.artists.count}
              max={LIMITS.tasteArtistsMax}
              ok={check.artists.ok}
            />

            <View style={styles.addRow}>
              <TextInput
                value={artistInput}
                onChangeText={(t) => {
                  setArtistInput(t);
                  if (artistError) setArtistError(null);
                }}
                onSubmitEditing={onAddArtist}
                onFocus={() => setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 250)}
                placeholder="Добавить своего артиста"
                placeholderTextColor={colors.textFaint}
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType="done"
                submitBehavior="submit"
                maxLength={80}
                editable={!check.artists.atMax}
                accessibilityLabel="Имя артиста"
                selectionColor={colors.accent}
                style={styles.input}
                testID="artist-input"
              />
              <IconButton icon="add" label="Добавить артиста" onPress={onAddArtist} filled disabled={!artistInput.trim()} testID="artist-add" />
            </View>
            {artistError ? (
              <Txt variant="caption" color={colors.danger} accessibilityLiveRegion="polite">
                {artistError}
              </Txt>
            ) : null}

            <View style={styles.chips}>
              {artistChips.map((a) => (
                <Chip key={a.toLocaleLowerCase('ru')} label={a} selected={hasArtist(draft.artists, a)} onToggle={() => onArtistChip(a)} />
              ))}
            </View>
            <SuggestionsState
              noGenres={draft.genres.length === 0}
              loading={suggestions.isFetching && !suggestions.data}
              failed={suggestions.isError && !suggestions.data}
              empty={Boolean(suggestions.data) && suggestions.data?.artists.length === 0}
              onRetry={() => void suggestions.refetch()}
            />
          </Animated.View>
        </ScrollView>
      </Screen>
    </KeyboardAvoidingView>
  );
}

function SectionHead({ title, rule, count, max, ok }: { title: string; rule: string; count: number; max: number; ok: boolean }) {
  return (
    <View style={styles.head}>
      <View style={styles.headText}>
        <Txt variant="heading" accessibilityRole="header">
          {title}
        </Txt>
        <Txt variant="caption" color={colors.textFaint}>
          {rule}
        </Txt>
      </View>
      <View style={[styles.counter, ok && styles.counterOk]} accessibilityLabel={`Выбрано ${count}`}>
        <Txt variant="label" color={ok ? colors.accent : colors.textMuted}>
          {`${count}/${max}`}
        </Txt>
      </View>
    </View>
  );
}

function SuggestionsState(props: { noGenres: boolean; loading: boolean; failed: boolean; empty: boolean; onRetry: () => void }) {
  if (props.noGenres) {
    return (
      <Txt variant="caption" color={colors.textFaint}>
        Выберите жанры — подскажем артистов.
      </Txt>
    );
  }
  if (props.loading) {
    return (
      <View style={styles.chips} accessibilityLabel="Загружаем подсказки" accessibilityRole="progressbar">
        {[92, 128, 76, 110].map((w) => (
          <View key={w} style={[styles.skeleton, { width: w }]} />
        ))}
      </View>
    );
  }
  if (props.failed) {
    return (
      <View style={styles.retryRow}>
        <Txt variant="caption" color={colors.textMuted} style={styles.retryText}>
          Подсказки не загрузились — можно добавить артистов вручную.
        </Txt>
        <Pressable accessibilityRole="button" onPress={props.onRetry} hitSlop={4} style={styles.retry}>
          <Txt variant="label" color={colors.violet}>
            Повторить
          </Txt>
        </Pressable>
      </View>
    );
  }
  if (props.empty) {
    return (
      <Txt variant="caption" color={colors.textFaint}>
        Подсказок нет — добавьте артистов вручную.
      </Txt>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space(5), paddingTop: space(4), paddingBottom: space(6), flexGrow: 1 },
  section: { marginTop: space(8), gap: space(3) },
  head: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: space(3) },
  headText: { flex: 1, gap: space(0.5) },
  counter: {
    minWidth: 52,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    alignItems: 'center',
  },
  counterOk: { backgroundColor: colors.accentSoft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  input: {
    flex: 1,
    minHeight: HIT,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.text,
    paddingHorizontal: space(4),
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  skeleton: { height: 40, borderRadius: radius.pill, backgroundColor: colors.surface2 },
  retryRow: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  retryText: { flex: 1 },
  retry: { minHeight: HIT, justifyContent: 'center', paddingHorizontal: space(2) },
});
