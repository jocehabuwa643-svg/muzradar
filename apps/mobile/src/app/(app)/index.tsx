import Ionicons from '@expo/vector-icons/Ionicons';
import type { PresenceView, Viewport } from '@muzradar/shared';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocationGate, type LocationGateState } from '@/features/location/gate';
import { locationGateCopy } from '@/features/location/LocationGate';
import { sameViewport } from '@/features/map/features';
import { ListenerSheet } from '@/features/map/ListenerSheet';
import { RadarMap, type RadarMapHandle } from '@/features/map/RadarMap';
import { usePresenceFeed, type PresenceFeed } from '@/features/map/usePresenceFeed';
import { useNowPlaying } from '@/features/player';
import { appConfig } from '@/lib/config';
import { useSession } from '@/state/session';
import { Button, Notice, Screen, Txt } from '@/ui/components';
import { colors, HIT, radius, space } from '@/ui/theme';

function pluralListeners(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'слушатель';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'слушателя';
  return 'слушателей';
}

// ─── map-only: карта закрыта, остальное приложение работает ──────────────────

function MapLocked({ state, onResolve }: { state: LocationGateState; onResolve: () => Promise<void> }) {
  const copy = locationGateCopy(state);
  const [busy, setBusy] = useState(false);
  const act = () => {
    setBusy(true);
    void onResolve().finally(() => setBusy(false));
  };
  return (
    <Screen edges={['top']}>
      <Txt variant="title" accessibilityRole="header">
        Радар
      </Txt>
      <View style={styles.locked}>
        <View style={styles.lockedIcon}>
          <Ionicons name={copy.icon} size={36} color={colors.accent} />
        </View>
        <Txt variant="heading" align="center">
          Карта откроется с геолокацией
        </Txt>
        <Txt color={colors.textMuted} align="center">
          {copy.title}. {copy.reason}
        </Txt>
        <Txt variant="caption" color={colors.textFaint} align="center">
          Музыка работает и без неё.
        </Txt>
        {copy.action ? <Button label={copy.action} onPress={act} loading={busy} /> : null}
      </View>
    </Screen>
  );
}

// ─── радар ───────────────────────────────────────────────────────────────────

function CountPill({ feed }: { feed: PresenceFeed }) {
  const searching = feed.status === 'loading' || feed.status === 'idle';
  if (searching && feed.count === 0) {
    return (
      <View style={styles.pill} accessible accessibilityLabel="Ищем слушателей рядом">
        <ActivityIndicator size="small" color={colors.accent} />
        <Txt variant="label" color={colors.textMuted}>
          Ищем…
        </Txt>
      </View>
    );
  }
  return (
    <View style={styles.pill} accessible accessibilityLabel={`${feed.count} ${pluralListeners(feed.count)} рядом`} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: feed.count > 0 ? colors.accent : colors.textFaint }]} />
      <Txt variant="label">{feed.count} рядом</Txt>
    </View>
  );
}

/** Своё состояние: что видят другие. Тап — в плеер или к музыке. */
function OwnStatus() {
  const { track, playing } = useNowPlaying((s) => ({ track: s.track, playing: s.playing }));
  const onAir = track !== null && playing;
  const label = track
    ? `${onAir ? 'В эфире' : 'На паузе'} · ${track.title} — ${track.artist}`
    : 'Включите музыку — вас увидят';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={track ? `${onAir ? 'Вас слышат рядом' : 'На паузе'}: ${track.title}, ${track.artist}` : 'Включите музыку — вас увидят'}
      accessibilityHint={track ? 'Открывает плеер' : 'Открывает раздел «Музыка»'}
      onPress={() => (track ? router.push('/player') : router.navigate('/music'))}
      style={({ pressed }) => [styles.status, onAir && styles.statusOnAir, pressed && styles.pressed]}
    >
      <Ionicons name={onAir ? 'radio' : 'musical-notes-outline'} size={18} color={onAir ? colors.accent : colors.textMuted} />
      <Txt variant="label" color={onAir ? colors.text : colors.textMuted} numberOfLines={1} style={styles.flex}>
        {label}
      </Txt>
      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
    </Pressable>
  );
}

function StateCard({ feed }: { feed: PresenceFeed }) {
  if (feed.status === 'error') {
    return (
      <View style={styles.card}>
        <Notice tone="danger" title="Не удалось загрузить слушателей">
          Проверьте интернет — карта обновится сама.
        </Notice>
        <Button label="Повторить" icon="refresh" variant="secondary" onPress={feed.retry} />
      </View>
    );
  }
  if (feed.status === 'ready' && feed.count === 0) {
    return (
      <View style={styles.card} accessible accessibilityLiveRegion="polite">
        <Txt variant="heading">Рядом пока тихо</Txt>
        <Txt color={colors.textMuted}>Включите музыку — и вы появитесь на радаре первым. Или отдалите карту.</Txt>
      </View>
    );
  }
  return null;
}

function Radar({ showUser }: { showUser: boolean }) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const selfId = useSession((s) => s.userId);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const feed = usePresenceFeed(viewport, { focused, selfId });
  const mapRef = useRef<RadarMapHandle>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateFailed, setLocateFailed] = useState(false);

  const listenersRef = useRef(feed.listeners);
  listenersRef.current = feed.listeners;
  // Последнее известное о выбранном: если человек пропал с карты, карточка не исчезает из-под пальца
  const lastSeen = useRef<PresenceView | null>(null);
  const live = selectedId ? (feed.listeners.find((u) => u.userId === selectedId) ?? null) : null;
  if (live) lastSeen.current = live;
  const shown = selectedId ? (live ?? lastSeen.current) : null;
  const gone = shown !== null && live === null;

  const onViewportChange = useCallback((v: Viewport) => setViewport((prev) => (sameViewport(prev, v) ? prev : v)), []);
  const onSelect = useCallback((userId: string) => {
    const view = listenersRef.current.find((u) => u.userId === userId);
    if (!view) return;
    lastSeen.current = view;
    setSelectedId(userId);
  }, []);
  const closeSheet = useCallback(() => setSelectedId(null), []);

  // Отдалились до кластеров — отдельных людей на карте больше нет
  useEffect(() => {
    if (feed.mode === 'clusters') setSelectedId(null);
  }, [feed.mode]);

  const recenter = async () => {
    setLocating(true);
    setLocateFailed(false);
    const ok = (await mapRef.current?.recenter()) ?? false;
    setLocating(false);
    setLocateFailed(!ok);
  };

  return (
    <View style={styles.root}>
      <RadarMap
        ref={mapRef}
        mode={feed.mode}
        listeners={feed.listeners}
        clusters={feed.clusters}
        selectedId={selectedId}
        showUserLocation={showUser}
        onSelect={onSelect}
        onMapPress={closeSheet}
        onViewportChange={onViewportChange}
      />

      <LinearGradient
        colors={['rgba(7,7,12,0.92)', 'rgba(7,7,12,0)']}
        style={[styles.scrim, { height: insets.top + 150 }]}
        pointerEvents="none"
      />

      <View style={[styles.top, { paddingTop: insets.top + space(2) }]} pointerEvents="box-none">
        <View style={styles.titleRow} pointerEvents="box-none">
          <Txt variant="title" accessibilityRole="header">
            Радар
          </Txt>
          <CountPill feed={feed} />
        </View>
        <OwnStatus />
      </View>

      <View style={styles.bottom} pointerEvents="box-none">
        <View style={styles.fabRow} pointerEvents="box-none">
          {locateFailed ? (
            <View style={styles.hint} accessibilityLiveRegion="polite">
              <Txt variant="caption" color={colors.textMuted}>
                Не удалось определить, где вы
              </Txt>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Показать меня на карте"
            accessibilityState={{ disabled: !showUser, busy: locating }}
            disabled={!showUser || locating}
            onPress={() => void recenter()}
            style={({ pressed }) => [styles.fab, (!showUser || pressed) && styles.pressed]}
            testID="radar-recenter"
          >
            {locating ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="locate" size={24} color={colors.accent} />}
          </Pressable>
        </View>
        {shown ? <ListenerSheet listener={shown} gone={gone} onClose={closeSheet} /> : <StateCard feed={feed} />}
      </View>
    </View>
  );
}

export default function RadarScreen() {
  const gate = useLocationGate();
  // В режиме hard без геолокации всё закрывает корневой экран-блокировка; здесь решает только map-only.
  const blocked = appConfig.locationGate === 'map-only' && gate.state !== 'checking' && !gate.ok;
  if (blocked) return <MapLocked state={gate.state} onResolve={gate.resolve} />;
  return <Radar showUser={gate.ok} />;
}

const FAB = 52;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: space(4), gap: space(3) },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(3) },
  pill: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: space(3),
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: space(4),
    borderRadius: radius.pill,
    backgroundColor: colors.overlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  statusOnAir: { borderColor: colors.accentSoft },
  pressed: { opacity: 0.6 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space(3), paddingBottom: space(3), gap: space(3) },
  fabRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: space(2) },
  fab: {
    width: FAB,
    height: FAB,
    borderRadius: FAB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  hint: { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.pill, backgroundColor: colors.overlay },
  card: {
    gap: space(2),
    padding: space(4),
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  locked: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space(3), paddingBottom: space(10) },
  lockedIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
});
