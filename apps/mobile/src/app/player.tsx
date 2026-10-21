import Ionicons from '@expo/vector-icons/Ionicons';
import type { Track } from '@muzradar/shared';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Artwork } from '@/features/catalog/Artwork';
import { attributionFor, type AttributionLink } from '@/features/catalog/attribution';
import { hasStreamableAfter } from '@/features/catalog/playable';
import { PreviewBadge } from '@/features/catalog/PreviewBadge';
import { player, useNowPlaying, type QueueSource } from '@/features/player';
import { SeekBar } from '@/features/player/SeekBar';
import { absoluteUrl } from '@/lib/config';
import { Button, IconButton, Notice, Txt } from '@/ui/components';
import { colors, HIT, radius, space } from '@/ui/theme';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function close() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** Откуда играет очередь — две строки, чтобы не склонять имена («вместе с Маша»). */
function sourceLabel(source: QueueSource | null): { overline: string; title: string | null } {
  switch (source?.kind) {
    case 'listen':
      return { overline: 'Слушаете вместе', title: source.name };
    case 'section':
      return { overline: 'Из раздела', title: source.title };
    case 'search':
      return { overline: 'Из поиска', title: `«${source.query}»` };
    default:
      return { overline: 'Сейчас играет', title: null };
  }
}

function openLink(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

function tap(action: () => void) {
  return () => {
    void Haptics.selectionAsync().catch(() => undefined);
    action();
  };
}

/** Обложка с мягким свечением из неё же; на паузе чуть уменьшается. */
function Cover({ track, playing, size }: { track: Track; playing: boolean; size: number }) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(playing ? 1 : 0.92);
  useEffect(() => {
    scale.value = reduceMotion ? (playing ? 1 : 0.92) : withTiming(playing ? 1 : 0.92, { duration: 320, easing: EASE_OUT });
  }, [playing, reduceMotion, scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const art = absoluteUrl(track.artworkUrl);

  return (
    <View style={[styles.cover, { width: size, height: size }]} accessible={false} importantForAccessibility="no-hide-descendants">
      {art ? (
        <Image source={{ uri: art }} blurRadius={48} contentFit="cover" style={[styles.glow, { borderRadius: radius.xl }]} />
      ) : (
        <View style={[styles.glow, styles.glowFallback]} />
      )}
      <Animated.View style={[styles.coverShadow, style]}>
        <Artwork uri={track.artworkUrl} size={size} radius={radius.lg} />
      </Animated.View>
    </View>
  );
}

function PlayerSeek() {
  const { positionSec, durationSec } = useNowPlaying((s) => ({ positionSec: s.positionSec, durationSec: s.durationSec }));
  return <SeekBar positionSec={positionSec} durationSec={durationSec} onSeek={player.seek} />;
}

function LinkChip({ link }: { link: AttributionLink }) {
  return (
    <Pressable
      onPress={() => openLink(link.url)}
      accessibilityRole="link"
      accessibilityLabel={link.label}
      accessibilityHint="Откроется в браузере"
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [styles.linkChip, pressed && { opacity: 0.7 }]}
    >
      <Txt variant="label" color={colors.violet}>
        {link.label}
      </Txt>
      <Ionicons name="open-outline" size={14} color={colors.violet} />
    </Pressable>
  );
}

function AttributionBlock({ track }: { track: Track }) {
  const a = attributionFor(track);
  return (
    <View style={styles.attribution}>
      <Txt variant="overline" color={colors.textFaint}>
        Источник · {a.provider}
      </Txt>
      <Txt variant="caption" color={colors.textMuted}>
        {a.credit}
      </Txt>
      {a.license || a.source ? (
        <View style={styles.links}>
          {a.license ? <LinkChip link={a.license} /> : null}
          {a.source ? <LinkChip link={a.source} /> : null}
        </View>
      ) : null}
    </View>
  );
}

export default function PlayerScreen() {
  const { width } = useWindowDimensions();
  const np = useNowPlaying((s) => ({
    track: s.track,
    playing: s.playing,
    buffering: s.buffering,
    shuffle: s.shuffle,
    source: s.source,
    error: s.error,
    hasNext: hasStreamableAfter(s.queue, s.index),
  }));
  const coverSize = Math.min(width - space(12), 360);
  const header = sourceLabel(np.source);

  return (
    <View style={styles.root}>
      <LinearGradient colors={['rgba(140,123,255,0.22)', 'rgba(7,7,12,0)']} style={styles.tint} pointerEvents="none" />
      <SafeAreaView edges={['top', 'bottom']} style={styles.safe}>
        <View style={styles.topBar}>
          <IconButton icon="chevron-down" label="Свернуть плеер" onPress={close} size={28} />
          <View style={styles.topTitle} accessible accessibilityRole="header">
            <Txt variant="overline" color={colors.textFaint} align="center">
              {header.overline}
            </Txt>
            {header.title ? (
              <Txt variant="label" align="center" numberOfLines={1}>
                {header.title}
              </Txt>
            ) : null}
          </View>
          <View style={styles.topSpacer} />
        </View>

        {!np.track ? (
          <View style={styles.empty}>
            <Ionicons name="musical-notes-outline" size={48} color={colors.violet} />
            <Txt variant="heading" align="center">
              Сейчас ничего не играет
            </Txt>
            <Txt color={colors.textMuted} align="center">
              Выберите трек во вкладке «Музыка» или нажмите на слушателя на радаре.
            </Txt>
            <Button label="Закрыть" variant="secondary" onPress={close} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Cover track={np.track} playing={np.playing} size={coverSize} />

            <View style={styles.titles}>
              <Txt variant="title" numberOfLines={2}>
                {np.track.title}
              </Txt>
              <Txt variant="body" color={colors.textMuted} numberOfLines={1}>
                {np.track.artist}
              </Txt>
              <PreviewBadge track={np.track} style={styles.preview} />
            </View>

            <PlayerSeek />

            <View style={styles.controls}>
              <Pressable
                onPress={tap(() => player.setShuffle(!np.shuffle))}
                accessibilityRole="switch"
                accessibilityLabel="Перемешать"
                accessibilityState={{ checked: np.shuffle }}
                hitSlop={8}
                style={styles.sideControl}
              >
                <Ionicons name="shuffle" size={24} color={np.shuffle ? colors.violet : colors.textMuted} />
                {np.shuffle ? <View style={styles.dot} /> : null}
              </Pressable>

              <IconButton icon="play-skip-back" label="Предыдущий трек" onPress={tap(player.prev)} size={32} />

              <Pressable
                onPress={tap(player.toggle)}
                accessibilityRole="button"
                accessibilityLabel={np.playing ? 'Пауза' : 'Играть'}
                accessibilityState={{ busy: np.buffering }}
                style={({ pressed }) => [styles.playButton, pressed && { transform: [{ scale: 0.96 }] }]}
              >
                {np.buffering ? (
                  <ActivityIndicator color={colors.accentInk} />
                ) : (
                  <Ionicons name={np.playing ? 'pause' : 'play'} size={34} color={colors.accentInk} style={!np.playing && styles.playIconNudge} />
                )}
              </Pressable>

              <IconButton icon="play-skip-forward" label="Следующий трек" onPress={tap(player.next)} disabled={!np.hasNext} size={32} />

              <View style={styles.sideControl} />
            </View>

            {np.error ? (
              <Notice tone="danger" title="Не играет">
                {np.error}
              </Notice>
            ) : null}

            <AttributionBlock track={np.track} />
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  tint: { position: 'absolute', top: 0, left: 0, right: 0, height: '55%' },
  safe: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space(2), minHeight: HIT + space(2) },
  topTitle: { flex: 1, alignItems: 'center', gap: 2 },
  topSpacer: { width: HIT },
  content: { paddingHorizontal: space(6), paddingTop: space(4), paddingBottom: space(8), gap: space(6) },
  cover: { alignSelf: 'center', marginVertical: space(2) },
  glow: {
    position: 'absolute',
    top: space(6),
    left: space(4),
    right: space(4),
    bottom: -space(2),
    opacity: 0.55,
  },
  glowFallback: { backgroundColor: colors.violetSoft, borderRadius: radius.xl },
  coverShadow: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
    borderRadius: radius.lg,
  },
  titles: { gap: space(1) },
  preview: { marginTop: space(1) },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideControl: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', bottom: 6, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.violet },
  playButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.violet,
  },
  playIconNudge: { marginLeft: 4 },
  attribution: {
    gap: space(2),
    padding: space(4),
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
  linkChip: {
    minHeight: HIT - 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1),
    paddingHorizontal: space(3),
    borderRadius: radius.pill,
    backgroundColor: colors.violetSoft,
  },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space(3), paddingHorizontal: space(8) },
});
