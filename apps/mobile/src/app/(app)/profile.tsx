import Ionicons from '@expo/vector-icons/Ionicons';
import { GENRES, MOODS, type Me, type Visibility } from '@muzradar/shared';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Switch, View } from 'react-native';
import { isLiveLocationRunning, startLiveLocation, stopLiveLocation } from '@/features/location/liveTask';
import { api } from '@/lib/api';
import { absoluteUrl, appConfig } from '@/lib/config';
import { useSession } from '@/state/session';
import { Notice, Screen, Txt, type IconName } from '@/ui/components';
import { colors, HIT, radius, space } from '@/ui/theme';

const LEGAL_LINKS: readonly { label: string; url: string }[] = [
  { label: 'Согласие на обработку персональных данных', url: 'https://muzradar.app/legal/processing' },
  { label: 'Согласие на распространение данных', url: 'https://muzradar.app/legal/dissemination' },
  { label: 'Правила сообщества', url: 'https://muzradar.app/legal/rules' },
  { label: 'Как работают рекомендации', url: 'https://muzradar.app/legal/recommendations' },
  { label: 'Политика конфиденциальности Audius', url: 'https://audius.co/legal/privacy-policy' },
  { label: 'Условия API Audius', url: 'https://audius.co/documents/ApiTerms.pdf' },
];

const VISIBILITY_COPY: Record<Visibility, { icon: IconName; title: string; text: string; tone: string }> = {
  public: {
    icon: 'radio',
    title: 'Вас видят слушатели рядом',
    text: 'Незнакомцы видят приблизительную зону — около километра, без точного адреса.',
    tone: colors.accent,
  },
  followers: {
    icon: 'people',
    title: 'Только взаимные подписки',
    text: 'Вас видят только те, с кем вы подписаны друг на друга.',
    tone: colors.violet,
  },
  ghost: {
    icon: 'eye-off',
    title: 'Невидимка',
    text: 'Вас нет на карте. Музыку слушать можно как обычно.',
    tone: colors.textMuted,
  },
};

const GENRE_LABEL = new Map<string, string>(GENRES.map((g) => [g.id, g.label]));
const MOOD_LABEL = new Map<string, string>(MOODS.map((m) => [m.id, `${m.emoji} ${m.label}`]));

function openLink(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

function initials(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function Avatar({ me }: { me: Me }) {
  const uri = absoluteUrl(me.avatarUrl);
  return (
    <View style={styles.avatarRing} accessible accessibilityRole="image" accessibilityLabel="Ваше фото">
      {uri ? (
        <Image source={{ uri }} style={styles.avatar} contentFit="cover" transition={150} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback]}>
          <Txt variant="title" color={colors.violet}>
            {initials(me.name) || '?'}
          </Txt>
        </View>
      )}
    </View>
  );
}

/** Метка вкуса: только показывает, не нажимается — поэтому не Chip. */
function Tag({ label }: { label: string }) {
  return (
    <View style={styles.tag}>
      <Txt variant="label" color={colors.text}>
        {label}
      </Txt>
    </View>
  );
}

function TasteBlock({ me }: { me: Me }) {
  const taste = me.taste;
  if (!taste) return null;
  const groups: { title: string; items: string[] }[] = [
    { title: 'Жанры', items: taste.genres.map((g) => GENRE_LABEL.get(g) ?? g) },
    { title: 'Настроения', items: taste.moods.map((m) => MOOD_LABEL.get(m) ?? m) },
    { title: 'Артисты', items: taste.artists },
  ];
  return (
    <View style={styles.block}>
      <Txt variant="heading">Музыкальный вкус</Txt>
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <View key={g.title} style={styles.group} accessible accessibilityLabel={`${g.title}: ${g.items.join(', ')}`}>
            <Txt variant="overline" color={colors.textFaint}>
              {g.title}
            </Txt>
            <View style={styles.tags}>
              {g.items.map((item) => (
                <Tag key={item} label={item} />
              ))}
            </View>
          </View>
        ))}
    </View>
  );
}

function LiveModeRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    isLiveLocationRunning()
      .then((v) => alive && setOn(v))
      .catch(() => alive && setOn(false));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (next) await startLiveLocation();
      else await stopLiveLocation();
      setOn(await isLiveLocationRunning());
    } catch {
      setError(next ? 'Не удалось включить Live-режим. Проверьте доступ к геолокации.' : 'Не удалось выключить Live-режим.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.block}>
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Txt variant="bodyStrong">Live-режим</Txt>
          <Txt variant="caption" color={colors.textMuted}>
            Точка на карте обновляется, даже когда приложение свёрнуто. С телефона уходит только приблизительная зона, не
            координаты.
          </Txt>
        </View>
        {on === null || busy ? (
          <ActivityIndicator color={colors.accent} style={styles.switchSpinner} />
        ) : (
          <Switch
            value={on}
            onValueChange={(v) => void toggle(v)}
            trackColor={{ false: colors.surface3, true: colors.accent }}
            thumbColor={on ? colors.accentInk : colors.textMuted}
            ios_backgroundColor={colors.surface3}
            accessibilityLabel="Live-режим"
          />
        )}
      </View>
      {error ? <Notice tone="danger" title={error} /> : null}
    </View>
  );
}

function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      onPress={() => openLink(url)}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityHint="Откроется в браузере"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Txt variant="body" style={styles.rowLabel}>
        {label}
      </Txt>
      <Ionicons name="open-outline" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

export default function ProfileScreen() {
  const cached = useSession((s) => s.me);
  // Профиль из кэша виден сразу; свежий подтягивается фоном и сохраняется в сессию
  const fresh = useQuery({
    queryKey: ['me'],
    queryFn: async ({ signal }) => {
      const me = await api.me(signal);
      useSession.getState().applyServerMe(me);
      return me;
    },
    staleTime: 60_000,
  });
  const me = fresh.data ?? cached;
  const visibility = me ? VISIBILITY_COPY[me.visibility] : null;
  const variant = appConfig.appVariant === 'production' ? '' : ` · ${appConfig.appVariant}`;

  return (
    <Screen edges={['top']} scroll>
      <View style={styles.content}>
        {me ? (
          <>
            <View style={styles.hero}>
              <Avatar me={me} />
              <Txt variant="title" align="center" numberOfLines={2}>
                {me.name ?? 'Без имени'}
              </Txt>
            </View>

            {visibility ? (
              <View style={styles.visibility} accessible accessibilityLabel={`${visibility.title}. ${visibility.text}`}>
                <View style={[styles.visibilityIcon, { borderColor: visibility.tone }]}>
                  <Ionicons name={visibility.icon} size={20} color={visibility.tone} />
                </View>
                <View style={styles.visibilityText}>
                  <Txt variant="bodyStrong">{visibility.title}</Txt>
                  <Txt variant="caption" color={colors.textMuted}>
                    {visibility.text}
                  </Txt>
                </View>
              </View>
            ) : null}

            <TasteBlock me={me} />
          </>
        ) : fresh.isError ? (
          <Notice tone="warning" title="Профиль не загрузился">
            Проверьте интернет — данные появятся, как только связь вернётся.
          </Notice>
        ) : (
          <ActivityIndicator color={colors.violet} style={styles.loading} accessibilityLabel="Загружаем профиль" />
        )}

        {appConfig.liveLocation ? <LiveModeRow /> : null}

        <View style={styles.block}>
          <Txt variant="heading">Документы</Txt>
          <View style={styles.list}>
            {LEGAL_LINKS.map((l) => (
              <LinkRow key={l.url} label={l.label} url={l.url} />
            ))}
          </View>
        </View>

        <View style={styles.list}>
          <View style={[styles.row, styles.rowDisabled]} accessible accessibilityRole="button" accessibilityState={{ disabled: true }}>
            <Txt variant="body" color={colors.textFaint} style={styles.rowLabel}>
              Удалить аккаунт — скоро
            </Txt>
            <Ionicons name="trash-outline" size={18} color={colors.textFaint} />
          </View>
        </View>

        <Txt variant="caption" color={colors.textFaint} align="center">
          МУЗРАДАР {appConfig.appVersion}
          {variant}
        </Txt>
      </View>
    </Screen>
  );
}

const AVATAR = 112;

const styles = StyleSheet.create({
  content: { gap: space(6), paddingBottom: space(10) },
  loading: { marginVertical: space(10) },
  hero: { alignItems: 'center', gap: space(3), paddingTop: space(2) },
  avatarRing: {
    width: AVATAR + 8,
    height: AVATAR + 8,
    borderRadius: (AVATAR + 8) / 2,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, backgroundColor: colors.surface2 },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.violetSoft },
  visibility: {
    flexDirection: 'row',
    gap: space(3),
    alignItems: 'center',
    padding: space(4),
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  visibilityIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  visibilityText: { flex: 1, gap: 2 },
  block: { gap: space(3) },
  group: { gap: space(2) },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  tag: {
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    borderRadius: radius.pill,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space(4), minHeight: HIT },
  switchText: { flex: 1, gap: 2 },
  switchSpinner: { width: 51 },
  list: {
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingHorizontal: space(4),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surface2 },
  rowDisabled: { borderBottomWidth: 0 },
  rowLabel: { flex: 1 },
});
