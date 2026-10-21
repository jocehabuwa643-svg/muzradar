// react-native-mmkv 4 сам подменяется на in-memory под Jest, но импорт nitro-modules падает без нативного модуля.
jest.mock('react-native-nitro-modules', () => ({}));

// Нативные модули, которых нет в jest-expo: только то, что реально импортируется в тестах.
// MapLibre v11: компоненты — обычные View, все пропсы лежат на View с testID, чтобы тест читал data/filter
// и вызывал onPress/onRegionDidChange через fireEvent. Методы ref — jest.fn с правдоподобными ответами;
// последний смонтированный ref каждого вида доступен тестам как mockRefs (через jest.requireMock).
// Типы — снаружи фабрики: babel-plugin-jest-hoist принимает объявленные в ней типы за чужие переменные.
type MockProps = Record<string, unknown> & {
  children?: import('react').ReactNode;
  ref?: import('react').Ref<unknown>;
  testID?: string;
  id?: string;
};
type MockHost = import('react').ComponentType<Record<string, unknown>>;

jest.mock('@maplibre/maplibre-react-native', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Host = View as unknown as MockHost;

  // Москва на зуме 14 — примерно то, что видит телефон шириной 390 pt
  const CENTER: [number, number] = [37.6176, 55.7558];
  const ZOOM = 14;
  const BOUNDS: [number, number, number, number] = [37.6006, 55.7358, 37.6346, 55.7758];

  const mockRefs: { map: object | null; camera: object | null; sources: Record<string, object> } = {
    map: null,
    camera: null,
    sources: {},
  };

  function useHandle<T extends object>(ref: MockProps['ref'], make: () => T, attach: (handle: T) => () => void): void {
    const [handle] = React.useState(make);
    React.useImperativeHandle(ref, () => handle, [handle]);
    // attach — новая функция каждый рендер, но регистрировать нужно один раз на экземпляр
    React.useEffect(() => attach(handle), [handle]);
  }

  function MapMock({ children, ref, testID, ...rest }: MockProps) {
    useHandle(
      ref,
      () => ({
        getCenter: jest.fn(async () => CENTER),
        getZoom: jest.fn(async () => ZOOM),
        getBearing: jest.fn(async () => 0),
        getPitch: jest.fn(async () => 0),
        getBounds: jest.fn(async () => BOUNDS),
        getViewState: jest.fn(async () => ({ center: CENTER, zoom: ZOOM, bearing: 0, pitch: 0, bounds: BOUNDS })),
        project: jest.fn(async () => [0, 0]),
        unproject: jest.fn(async () => CENTER),
        queryRenderedFeatures: jest.fn(async () => []),
        setSourceVisibility: jest.fn(async () => undefined),
        showAttribution: jest.fn(async () => undefined),
      }),
      (handle) => {
        mockRefs.map = handle;
        return () => {
          if (mockRefs.map === handle) mockRefs.map = null;
        };
      },
    );
    return React.createElement(Host, { ...rest, testID: testID ?? 'maplibre-map' }, children);
  }

  function Camera({ children, ref, testID, ...rest }: MockProps) {
    useHandle(
      ref,
      () => ({
        jumpTo: jest.fn(),
        easeTo: jest.fn(),
        flyTo: jest.fn(),
        fitBounds: jest.fn(),
        zoomTo: jest.fn(),
        setStop: jest.fn(async () => undefined),
      }),
      (handle) => {
        mockRefs.camera = handle;
        return () => {
          if (mockRefs.camera === handle) mockRefs.camera = null;
        };
      },
    );
    return React.createElement(Host, { ...rest, testID: testID ?? 'maplibre-camera' }, children);
  }

  function GeoJSONSource({ children, ref, testID, id, ...rest }: MockProps) {
    const key = id ?? 'geojson';
    const data = React.useRef(rest.data);
    data.current = rest.data;
    useHandle(
      ref,
      () => ({
        getData: jest.fn(async () => data.current ?? { type: 'FeatureCollection', features: [] }),
        getClusterExpansionZoom: jest.fn(async () => ZOOM + 2),
        getClusterLeaves: jest.fn(async () => []),
        getClusterChildren: jest.fn(async () => []),
        getAnimatableRef: jest.fn(() => null),
      }),
      (handle) => {
        mockRefs.sources[key] = handle;
        return () => {
          if (mockRefs.sources[key] === handle) delete mockRefs.sources[key];
        };
      },
    );
    return React.createElement(Host, { ...rest, id, testID: testID ?? `maplibre-source-${key}` }, children);
  }

  function Layer({ children, testID, id, ...rest }: MockProps) {
    return React.createElement(Host, { ...rest, id, testID: testID ?? `maplibre-layer-${id ?? 'layer'}` }, children);
  }

  function Images({ children, testID, ...rest }: MockProps) {
    return React.createElement(Host, { ...rest, testID: testID ?? 'maplibre-images' }, children);
  }

  function NativeUserLocation({ children, testID, ...rest }: MockProps) {
    return React.createElement(Host, { ...rest, testID: testID ?? 'maplibre-native-user-location' }, children);
  }

  return { __esModule: true, Map: MapMock, Camera, GeoJSONSource, Layer, Images, NativeUserLocation, mockRefs };
});
// expo-audio при импорте читает AudioModule.AudioPlayer.prototype, которого нет в нативных моках jest-expo.
jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    replace: jest.fn(),
    seekTo: jest.fn(async () => undefined),
    setActiveForLockScreen: jest.fn(),
    updateLockScreenMetadata: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    isLoaded: false,
  })),
  preload: jest.fn(async () => undefined),
  clearPreloadedSource: jest.fn(async () => undefined),
  setAudioModeAsync: jest.fn(async () => undefined),
}));
jest.mock('@infinitered/react-native-mlkit-face-detection', () => ({
  RNMLKitFaceDetector: jest.fn(),
}));

// Модуль, а не скрипт: типы выше не должны становиться глобальными для всего проекта.
export {};
