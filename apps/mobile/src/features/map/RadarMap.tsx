import {
  Camera,
  GeoJSONSource,
  Images,
  Layer,
  Map as MapLibreMap,
  NativeUserLocation,
  type CameraRef,
  type CircleLayerSpecification,
  type FilterSpecification,
  type GeoJSONSourceRef,
  type InitialViewState,
  type LngLat,
  type MapRef,
  type PressEventWithFeatures,
  type SymbolLayerSpecification,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { PRESENCE, type ClusterCell, type PresenceView, type Viewport } from '@muzradar/shared';
import * as Location from 'expo-location';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { StyleSheet, View, type NativeSyntheticEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { colors } from '@/ui/theme';
import { avatarImages, clustersToFeatures, EMPTY_COLLECTION, listenersToFeatures, toViewport, zonesToFeatures } from './features';
import { MAP_FONTS, radarMapStyle } from './style';
import type { FeedMode } from './usePresenceFeed';

export const MOSCOW: LngLat = [37.6176, 55.7558];
const DEFAULT_ZOOM = 13;
const USER_ZOOM = 14;
const VIEWPORT_DEBOUNCE_MS = 400;
/** Сколько ждём последнюю известную позицию перед первым кадром, прежде чем показать Москву. */
const INITIAL_FIX_WAIT_MS = 600;

// Последний вид карты — только в памяти: вкладку пересоздали, а карта осталась там же.
let lastView: { center: LngLat; zoom: number } | null = null;

async function lastKnownCenter(maxAgeMs: number): Promise<LngLat | null> {
  try {
    const pos = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    return pos ? [pos.coords.longitude, pos.coords.latitude] : null;
  } catch {
    return null;
  }
}

/** Координаты остаются на устройстве: они нужны только камере. */
async function deviceCenter(): Promise<LngLat | null> {
  const recent = await lastKnownCenter(60_000);
  if (recent) return recent;
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return [pos.coords.longitude, pos.coords.latitude];
  } catch {
    return null;
  }
}

function useInitialView(): InitialViewState | null {
  const [initial, setInitial] = useState<InitialViewState | null>(() =>
    lastView ? { center: lastView.center, zoom: lastView.zoom } : null,
  );
  useEffect(() => {
    if (initial) return;
    let done = false;
    const finish = (center: LngLat | null) => {
      if (done) return;
      done = true;
      setInitial(center ? { center, zoom: USER_ZOOM } : { center: MOSCOW, zoom: DEFAULT_ZOOM });
    };
    const timer = setTimeout(() => finish(null), INITIAL_FIX_WAIT_MS);
    void lastKnownCenter(30 * 60_000).then(finish);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [initial]);
  return initial;
}

// ─── слои ────────────────────────────────────────────────────────────────────

const IS_CLUSTER: FilterSpecification = ['has', 'point_count'];
const IS_POINT: FilterSpecification = ['!', ['has', 'point_count']];
const IS_APPROX: ['==', ['get', string], boolean] = ['==', ['get', 'approx'], true];
/** Маркер приблизительного слушателя приглушён: это центр квартала, а не человек на улице. */
const APPROX_OPACITY = 0.5;

const CLUSTER_CIRCLE_PAINT: CircleLayerSpecification['paint'] = {
  'circle-color': 'rgba(200,255,61,0.16)',
  'circle-stroke-color': colors.accent,
  'circle-stroke-width': 1.5,
  'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 50, 27, 200, 32],
};

const COUNT_LAYOUT: SymbolLayerSpecification['layout'] = {
  'text-font': [MAP_FONTS.bold],
  'text-size': 13,
  'text-allow-overlap': true,
  'text-ignore-placement': true,
};

export interface RadarMapHandle {
  /** Камера к своей позиции; false — позиция неизвестна. */
  recenter(): Promise<boolean>;
}

export interface RadarMapProps {
  mode: FeedMode;
  listeners: readonly PresenceView[];
  clusters: readonly ClusterCell[];
  selectedId: string | null;
  /** Своя точка на карте — только при выданной геолокации. */
  showUserLocation: boolean;
  onSelect: (userId: string) => void;
  onMapPress: () => void;
  onViewportChange: (viewport: Viewport) => void;
  ref?: Ref<RadarMapHandle>;
}

export function RadarMap({
  mode,
  listeners,
  clusters,
  selectedId,
  showUserLocation,
  onSelect,
  onMapPress,
  onViewportChange,
  ref,
}: RadarMapProps) {
  const initial = useInitialView();
  const reduceMotion = useReducedMotion();
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const listenersRef = useRef<GeoJSONSourceRef>(null);
  const zoomRef = useRef(lastView?.zoom ?? DEFAULT_ZOOM);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewportRef = useRef(onViewportChange);
  onViewportRef.current = onViewportChange;

  const duration = reduceMotion ? 0 : 450;

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      recenter: async () => {
        const center = await deviceCenter();
        if (!center) return false;
        const zoom = Math.max(zoomRef.current, USER_ZOOM);
        if (reduceMotion) cameraRef.current?.jumpTo({ center, zoom });
        else cameraRef.current?.easeTo({ center, zoom, duration: 600 });
        return true;
      },
    }),
    [reduceMotion],
  );

  const liveData = useMemo(() => (mode === 'live' ? listenersToFeatures(listeners) : EMPTY_COLLECTION), [mode, listeners]);
  const zoneData = useMemo(() => (mode === 'live' ? zonesToFeatures(listeners) : EMPTY_COLLECTION), [mode, listeners]);
  const cellData = useMemo(() => (mode === 'clusters' ? clustersToFeatures(clusters) : EMPTY_COLLECTION), [mode, clusters]);
  const images = useMemo(() => avatarImages(listeners), [listeners]);

  const emitViewport = useCallback((bounds: [number, number, number, number], zoom: number, immediate: boolean) => {
    if (debounce.current) clearTimeout(debounce.current);
    const send = () => onViewportRef.current(toViewport(bounds, zoom));
    if (immediate) send();
    else debounce.current = setTimeout(send, VIEWPORT_DEBOUNCE_MS);
  }, []);

  const onRegionDidChange = useCallback(
    (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const { bounds, zoom, center } = e.nativeEvent;
      zoomRef.current = zoom;
      lastView = { center, zoom };
      emitViewport(bounds, zoom, false);
    },
    [emitViewport],
  );

  // Первый вьюпорт — сразу после загрузки стиля, не дожидаясь жеста.
  const onDidFinishLoadingMap = useCallback(async () => {
    try {
      const [bounds, zoom] = await Promise.all([mapRef.current?.getBounds(), mapRef.current?.getZoom()]);
      if (bounds && zoom !== undefined) {
        zoomRef.current = zoom;
        emitViewport(bounds, zoom, true);
      }
    } catch {
      // onRegionDidChange всё равно придёт
    }
  }, [emitViewport]);

  const onListenersPress = useCallback(
    async (e: NativeSyntheticEvent<PressEventWithFeatures>) => {
      e.stopPropagation();
      const { features } = e.nativeEvent;
      const person = features.find((f) => typeof f.properties?.userId === 'string');
      if (person) {
        onSelect(person.properties?.userId as string);
        return;
      }
      const cluster = features.find((f) => typeof f.properties?.cluster_id === 'number');
      if (!cluster || cluster.geometry.type !== 'Point') return;
      const [lng, lat] = cluster.geometry.coordinates;
      if (lng === undefined || lat === undefined) return;
      try {
        const zoom = await listenersRef.current?.getClusterExpansionZoom(cluster.properties?.cluster_id as number);
        cameraRef.current?.easeTo({ center: [lng, lat], zoom: zoom ?? zoomRef.current + 2, duration });
      } catch {
        cameraRef.current?.easeTo({ center: [lng, lat], zoom: zoomRef.current + 2, duration });
      }
    },
    [onSelect, duration],
  );

  // Тап по кварталу — то же, что тап по человеку: карточка и «Слушать вместе».
  const onZonesPress = useCallback(
    (e: NativeSyntheticEvent<PressEventWithFeatures>) => {
      e.stopPropagation();
      const zone = e.nativeEvent.features.find((f) => typeof f.properties?.userId === 'string');
      if (zone) onSelect(zone.properties?.userId as string);
    },
    [onSelect],
  );

  // Серверные кластеры: приближаем до живого режима, дальше разбирается нативная кластеризация.
  const onCellsPress = useCallback(
    (e: NativeSyntheticEvent<PressEventWithFeatures>) => {
      e.stopPropagation();
      const cell = e.nativeEvent.features.find((f) => f.geometry.type === 'Point');
      if (!cell || cell.geometry.type !== 'Point') return;
      const [lng, lat] = cell.geometry.coordinates;
      if (lng === undefined || lat === undefined) return;
      const zoom = Math.min(zoomRef.current + 2, PRESENCE.liveMinZoom + 0.5);
      cameraRef.current?.easeTo({ center: [lng, lat], zoom, duration });
    },
    [duration],
  );

  if (!initial) return <View style={styles.placeholder} />;

  return (
    <MapLibreMap
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      mapStyle={radarMapStyle}
      logo={false}
      compass={false}
      touchPitch={false}
      attribution
      attributionPosition={{ bottom: 8, left: 8 }}
      onPress={onMapPress}
      onRegionDidChange={onRegionDidChange}
      onDidFinishLoadingMap={onDidFinishLoadingMap}
      testID="radar-map"
    >
      <Camera ref={cameraRef} initialViewState={initial} minZoom={3} maxZoom={17} />
      <Images images={images} />

      <GeoJSONSource id="listener-cells" data={cellData} onPress={onCellsPress}>
        <Layer id="cells-circle" type="circle" paint={{ ...CLUSTER_CIRCLE_PAINT, 'circle-radius': ['step', ['get', 'count'], 18, 10, 22, 50, 27, 200, 32] }} />
        <Layer
          id="cells-count"
          type="symbol"
          layout={{ ...COUNT_LAYOUT, 'text-field': ['get', 'countLabel'] }}
          paint={{ 'text-color': colors.accent }}
        />
      </GeoJSONSource>

      {/* Кварталы приблизительных слушателей — под маркерами, чтобы не перекрывать аватары */}
      <GeoJSONSource id="listener-zones" data={zoneData} onPress={onZonesPress}>
        <Layer
          id="zone-fill"
          type="fill"
          paint={{
            'fill-color': colors.violet,
            'fill-opacity': ['case', ['==', ['get', 'playing'], true], 0.14, 0.08],
          }}
        />
        <Layer
          id="zone-outline"
          type="line"
          paint={{
            'line-color': ['case', ['==', ['get', 'userId'], selectedId ?? ''], colors.accent, colors.violet],
            'line-opacity': 0.55,
            'line-width': 1.2,
            'line-dasharray': [2, 2],
          }}
        />
      </GeoJSONSource>

      <GeoJSONSource
        id="listeners"
        ref={listenersRef}
        data={liveData}
        cluster
        clusterRadius={48}
        clusterMaxZoom={14}
        onPress={onListenersPress}
      >
        <Layer id="listener-clusters" type="circle" filter={IS_CLUSTER} paint={CLUSTER_CIRCLE_PAINT} />
        <Layer
          id="listener-cluster-count"
          type="symbol"
          filter={IS_CLUSTER}
          layout={{ ...COUNT_LAYOUT, 'text-field': ['get', 'point_count_abbreviated'] }}
          paint={{ 'text-color': colors.accent }}
        />
        {/* Свечение под тем, у кого играет музыка: чем быстрее движется, тем шире */}
        <Layer
          id="listener-glow"
          type="circle"
          filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'playing'], true], ['!', IS_APPROX]]}
          paint={{
            'circle-color': colors.accent,
            'circle-opacity': 0.22,
            'circle-blur': 0.7,
            'circle-radius': ['match', ['get', 'motion'], 'drive', 36, 'walk', 31, 27],
          }}
        />
        <Layer
          id="listener-selected"
          type="circle"
          filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'userId'], selectedId ?? '']]}
          paint={{ 'circle-radius': 24, 'circle-opacity': 0, 'circle-stroke-color': colors.accent, 'circle-stroke-width': 2.5 }}
        />
        {/* Без аватара — простая точка музыкального цвета */}
        <Layer
          id="listener-dot"
          type="circle"
          filter={['all', ['!', ['has', 'point_count']], ['==', ['get', 'hasAvatar'], false]]}
          paint={{
            'circle-color': colors.violet,
            'circle-radius': 9,
            'circle-stroke-color': colors.bg,
            'circle-stroke-width': 2,
            'circle-opacity': ['case', IS_APPROX, APPROX_OPACITY, 1],
            'circle-stroke-opacity': ['case', IS_APPROX, APPROX_OPACITY, 1],
          }}
        />
        <Layer
          id="listener-avatars"
          type="symbol"
          filter={IS_POINT}
          layout={{
            'icon-image': ['case', ['==', ['get', 'hasAvatar'], true], ['get', 'avatarKey'], ''],
            'icon-size': 0.42,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'text-field': ['get', 'trackTitle'],
            'text-font': [MAP_FONTS.regular],
            'text-size': 11,
            'text-anchor': 'top',
            'text-offset': [0, 1.9],
            'text-max-width': 9,
            'text-optional': true,
          }}
          paint={{
            'icon-opacity': ['case', IS_APPROX, APPROX_OPACITY, 1],
            'text-color': colors.textMuted,
            'text-halo-color': 'rgba(7,7,12,0.9)',
            'text-halo-width': 1.2,
          }}
        />
      </GeoJSONSource>

      {showUserLocation ? <NativeUserLocation mode="default" /> : null}
    </MapLibreMap>
  );
}

const styles = StyleSheet.create({
  placeholder: { flex: 1, backgroundColor: colors.bg },
});
