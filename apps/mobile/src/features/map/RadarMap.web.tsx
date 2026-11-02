import type { ClusterCell, PresenceView, Viewport } from '@muzradar/shared';
import maplibregl, { Map as GLMap, Marker, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors } from '@/ui/theme';
import { clustersToFeatures, EMPTY_COLLECTION, listenersToFeatures, listenerShape, toViewport, zonesToFeatures } from './features';
import { radarMapStyle, MAP_FONTS } from './style.web';
import type { FeedMode } from './usePresenceFeed';
import { createListenerElement, shouldCenterOnFirstFix } from './webFeatures';

if (typeof document !== 'undefined') require('maplibre-gl/dist/maplibre-gl.css');

export const MOSCOW: [number, number] = [37.6176, 55.7558];
const DEFAULT_ZOOM = 13;
const USER_ZOOM = 14;
let lastView: { center: [number, number]; zoom: number } | null = null;

export interface RadarMapHandle {
  recenter(): Promise<boolean>;
}

export interface RadarMapProps {
  mode: FeedMode;
  listeners: readonly PresenceView[];
  clusters: readonly ClusterCell[];
  selectedId: string | null;
  showUserLocation: boolean;
  onSelect: (userId: string) => void;
  onMapPress: () => void;
  onViewportChange: (viewport: Viewport) => void;
  ref?: Ref<RadarMapHandle>;
}

function currentPosition(): Promise<[number, number]> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve([position.coords.longitude, position.coords.latitude]),
      reject,
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 },
    );
  });
}

export function RadarMap(props: RadarMapProps) {
  const { ref, mode, listeners, clusters, selectedId, showUserLocation } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GLMap | null>(null);
  const markersRef = useRef(new Map<string, Marker>());
  const previousView = useRef(lastView);
  const [map, setMap] = useState<GLMap | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  const liveData = useMemo(() => (mode === 'live' ? listenersToFeatures(listeners) : EMPTY_COLLECTION), [mode, listeners]);
  const zoneData = useMemo(() => (mode === 'live' ? zonesToFeatures(listeners) : EMPTY_COLLECTION), [mode, listeners]);
  const cellData = useMemo(() => (mode === 'clusters' ? clustersToFeatures(clusters) : EMPTY_COLLECTION), [mode, clusters]);

  const emitViewport = useCallback((target: GLMap) => {
    const bounds = target.getBounds().toArray();
    const center = target.getCenter();
    lastView = { center: [center.lng, center.lat], zoom: target.getZoom() };
    callbacks.current.onViewportChange(toViewport([bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]], target.getZoom()));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const instance = new maplibregl.Map({
      container,
      style: radarMapStyle as StyleSpecification,
      center: lastView?.center ?? MOSCOW,
      zoom: lastView?.zoom ?? DEFAULT_ZOOM,
      minZoom: 3,
      maxZoom: 17,
      dragRotate: false,
      touchPitch: false,
      attributionControl: false,
    });
    mapRef.current = instance;
    instance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    instance.on('load', () => {
      instance.addSource('listener-zones', { type: 'geojson', data: EMPTY_COLLECTION });
      instance.addLayer({
        id: 'zone-fill',
        type: 'fill',
        source: 'listener-zones',
        paint: { 'fill-color': colors.violet, 'fill-opacity': ['case', ['==', ['get', 'playing'], true], 0.14, 0.08] },
      });
      instance.addLayer({
        id: 'zone-outline',
        type: 'line',
        source: 'listener-zones',
        paint: { 'line-color': colors.violet, 'line-opacity': 0.55, 'line-width': 1.2, 'line-dasharray': [2, 2] },
      });
      instance.addSource('listener-cells', { type: 'geojson', data: EMPTY_COLLECTION });
      instance.addLayer({
        id: 'cells-circle',
        type: 'circle',
        source: 'listener-cells',
        paint: {
          'circle-color': 'rgba(200,255,61,0.16)',
          'circle-stroke-color': colors.accent,
          'circle-stroke-width': 1.5,
          'circle-radius': ['step', ['get', 'count'], 18, 10, 22, 50, 27, 200, 32],
        },
      });
      instance.addLayer({
        id: 'cells-count',
        type: 'symbol',
        source: 'listener-cells',
        layout: { 'text-field': ['get', 'countLabel'], 'text-font': [MAP_FONTS.bold], 'text-size': 13, 'text-allow-overlap': true },
        paint: { 'text-color': colors.accent },
      });
      setMap(instance);
      emitViewport(instance);
    });
    instance.on('moveend', () => emitViewport(instance));
    instance.on('click', 'zone-fill', (event) => {
      const userId = event.features?.[0]?.properties?.userId;
      if (typeof userId === 'string') callbacks.current.onSelect(userId);
    });
    instance.on('click', 'cells-circle', (event) => {
      const feature = event.features?.[0];
      if (feature?.geometry.type !== 'Point') return;
      const [lng, lat] = feature.geometry.coordinates;
      if (lng !== undefined && lat !== undefined) instance.easeTo({ center: [lng, lat], zoom: Math.min(instance.getZoom() + 2, 12.5) });
    });
    instance.on('click', (event) => {
      const features = instance.queryRenderedFeatures(event.point, { layers: ['zone-fill', 'cells-circle'] });
      if (features.length === 0) callbacks.current.onMapPress();
    });
    return () => {
      for (const marker of markersRef.current.values()) marker.remove();
      markersRef.current.clear();
      instance.remove();
      mapRef.current = null;
      setMap(null);
    };
  }, [emitViewport]);

  useEffect(() => {
    if (!map) return;
    (map.getSource('listener-zones') as GeoJSONSource | undefined)?.setData(zoneData);
    (map.getSource('listener-cells') as GeoJSONSource | undefined)?.setData(cellData);
  }, [map, zoneData, cellData]);

  useEffect(() => {
    if (!map) return;
    const next = new Map<string, Marker>();
    for (const view of listeners) {
      const element = createListenerElement(view, callbacks.current.onSelect, view.userId === selectedId);
      const marker = new Marker({ element }).setLngLat(listenerShape(view).point).addTo(map);
      next.set(view.userId, marker);
    }
    for (const [userId, marker] of markersRef.current) if (!next.has(userId)) marker.remove();
    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current = next;
    return () => {
      for (const marker of next.values()) marker.remove();
    };
  }, [map, listeners, selectedId]);

  useEffect(() => {
    if (!map || !showUserLocation || !navigator.geolocation) return;
    const dot = document.createElement('div');
    dot.setAttribute('aria-label', 'Ваше приблизительное положение');
    dot.style.cssText = `width:18px;height:18px;border-radius:50%;background:${colors.accent};border:3px solid #07070C;box-shadow:0 0 0 6px rgba(200,255,61,.18)`;
    const marker = new Marker({ element: dot });
    let centred = false;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        const center: [number, number] = [position.coords.longitude, position.coords.latitude];
        marker.setLngLat(center).addTo(map);
        if (shouldCenterOnFirstFix(previousView.current, centred)) {
          centred = true;
          map.easeTo({ center, zoom: USER_ZOOM });
        }
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => {
      navigator.geolocation.clearWatch(watch);
      marker.remove();
    };
  }, [map, showUserLocation]);

  useImperativeHandle(ref, () => ({
    recenter: async () => {
      const target = mapRef.current;
      if (!target || !navigator.geolocation) return false;
      try {
        const center = await currentPosition();
        target.easeTo({ center, zoom: Math.max(target.getZoom(), USER_ZOOM) });
        return true;
      } catch {
        return false;
      }
    },
  }), []);

  return (
    <View style={styles.map} testID="radar-map">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} aria-label="Карта слушателей рядом" />
    </View>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, backgroundColor: colors.bg },
});
