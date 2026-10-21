import Ionicons from '@expo/vector-icons/Ionicons';
import type { PresenceView } from '@muzradar/shared';
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { Artwork } from '@/features/catalog';
import { absoluteUrl } from '@/lib/config';
import { Button, IconButton, Notice, Txt } from '@/ui/components';
import { colors, fonts, radius, space } from '@/ui/theme';
import { LISTEN_ERRORS } from './listen';
import { clearListenError, joinListening, leaveListening, useListenTogether } from './listenTogether';
import { MOTION_META } from './motion';

const AVATAR = 56;

function ListenerAvatar({ uri, name }: { uri: string | null; name: string }) {
  const src = absoluteUrl(uri);
  if (!src) {
    return (
      <View style={[styles.avatar, styles.avatarFallback]} accessible={false}>
        <Txt variant="heading" color={colors.violet}>
          {name.trim().charAt(0).toUpperCase() || '?'}
        </Txt>
      </View>
    );
  }
  return (
    <View style={styles.avatar} accessible={false}>
      <Image source={{ uri: src }} style={styles.avatarImage} contentFit="cover" recyclingKey={src} cachePolicy="memory-disk" transition={120} />
    </View>
  );
}

export interface ListenerSheetProps {
  listener: PresenceView;
  /** Слушатель пропал с карты, пока карточка открыта: показываем последнее известное. */
  gone: boolean;
  onClose: () => void;
}

/** Карточка выбранного слушателя: кто, как движется, что играет, «Слушать вместе». */
export function ListenerSheet({ listener, gone, onClose }: ListenerSheetProps) {
  const listen = useListenTogether();
  const mine = listen.userId === listener.userId;
  const joined = mine && listen.status === 'joined';
  const joining = mine && listen.status === 'joining';
  const { track } = listener;
  const motion = MOTION_META[listener.motion];
  const unavailable = track?.playback === 'unavailable';
  // Приблизительная геолокация: на карте квартал, и в карточке честно говорим, что точнее не знаем
  const whereLabel = listener.approx === true ? 'где-то в этом районе' : null;

  // Ошибка прошлого слушателя не должна висеть на карточке нового
  useEffect(() => {
    clearListenError();
  }, [listener.userId]);

  const summary = [
    listener.name,
    motion.label,
    ...(whereLabel ? [whereLabel] : []),
    track ? `${listener.playing ? 'слушает' : 'на паузе'}: ${track.title}, ${track.artist}` : 'сейчас ничего не играет',
  ].join(', ');

  return (
    <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(150)} style={styles.sheet} testID="listener-sheet">
      <View style={styles.header}>
        <View style={styles.identity} accessible accessibilityLabel={summary}>
          <ListenerAvatar uri={listener.mapAvatarUrl} name={listener.name} />
          <View style={styles.flex}>
            <Txt variant="heading" numberOfLines={1}>
              {listener.name}
            </Txt>
            <View style={styles.row}>
              <Ionicons name={motion.icon} size={16} color={colors.textMuted} />
              <Txt variant="caption" color={colors.textMuted}>
                {whereLabel ? `${motion.label} · ${whereLabel}` : motion.label}
              </Txt>
            </View>
          </View>
        </View>
        <IconButton icon="close" label="Закрыть карточку слушателя" onPress={onClose} color={colors.textMuted} />
      </View>

      {track ? (
        <View style={styles.track} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          <Artwork uri={track.artworkUrl} size={52} radius={radius.sm} />
          <View style={styles.flex}>
            <Txt variant="bodyStrong" numberOfLines={1}>
              {track.title}
            </Txt>
            <Txt variant="caption" color={colors.textMuted} numberOfLines={1}>
              {track.artist}
            </Txt>
            <View style={styles.row}>
              <View style={[styles.liveDot, { backgroundColor: listener.playing ? colors.accent : colors.textFaint }]} />
              <Txt variant="caption" color={listener.playing ? colors.accent : colors.textFaint}>
                {listener.playing ? 'Играет сейчас' : 'На паузе'}
              </Txt>
              {track.playback === 'preview' ? (
                <View style={styles.badge}>
                  <Txt variant="caption" color={colors.violet} style={styles.badgeText}>
                    Отрывок
                  </Txt>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.silent}>
          <Ionicons name="musical-notes-outline" size={20} color={colors.textFaint} />
          <Txt color={colors.textMuted}>Сейчас ничего не играет</Txt>
        </View>
      )}

      {gone ? <Notice title="Слушатель ушёл с карты">Показываем то, что он слушал последним.</Notice> : null}
      {unavailable ? <Notice tone="warning" title={LISTEN_ERRORS.trackUnavailable} /> : null}
      {mine && listen.error ? <Notice tone="warning" title={listen.error} /> : null}

      {joined ? (
        <View style={styles.actions}>
          <View style={styles.row} accessibilityLiveRegion="polite">
            <Ionicons name="headset" size={16} color={colors.accent} />
            <Txt variant="label" color={colors.accent}>
              Вы слушаете вместе
            </Txt>
          </View>
          <Button label="Отключиться" icon="close-circle-outline" variant="secondary" onPress={() => void leaveListening()} />
        </View>
      ) : (
        <Button
          label="Слушать вместе"
          icon="headset"
          loading={joining}
          disabled={!track || unavailable || gone}
          accessibilityHint="Включит тот же трек с того же места"
          onPress={() => void joinListening(listener)}
          testID="listen-together"
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space(4),
    gap: space(3),
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space(3) },
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2, overflow: 'hidden', backgroundColor: colors.surface2 },
  avatarImage: { width: '100%', height: '100%' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.violetSoft },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    padding: space(2),
    borderRadius: radius.md,
    backgroundColor: colors.surface2,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  badge: {
    paddingHorizontal: space(2),
    paddingVertical: 1,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.violet,
  },
  badgeText: { fontFamily: fonts.bodySemi },
  silent: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(2) },
  actions: { gap: space(2) },
});
