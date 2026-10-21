import type { ConfigContext, ExpoConfig } from 'expo/config';
import { withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

/**
 * Флаги сборки (переменные окружения EAS / локальные):
 * - LOCATION_GATE=hard|map-only — без геолокации блокируется всё приложение или только карта.
 * - LIVE_LOCATION=1 — фоновая трансляция позиции (фаза 2, нужна декларация в Google Play).
 * - EXPO_PUBLIC_API_URL — адрес API (эмулятор Android видит компьютер как 10.0.2.2).
 * - APP_VARIANT=development|preview|production.
 */
const LOCATION_GATE = process.env.LOCATION_GATE === 'map-only' ? 'map-only' : 'hard';
const LIVE_LOCATION = process.env.LIVE_LOCATION === '1';
const APP_VARIANT = process.env.APP_VARIANT ?? 'development';
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:8080';
const IS_PROD = APP_VARIANT === 'production';

// Тестовые сборки ходят к серверу разработчика по http://<адрес в Wi-Fi>:8080, а release-Android
// такой трафик по умолчанию режет. В production сервер только за HTTPS — там разрешение не нужно.
const withDevCleartext: ConfigPlugin = (cfg) =>
  withAndroidManifest(cfg, (mod) => {
    const app = mod.modResults.manifest.application?.[0];
    if (app) app.$['android:usesCleartextTraffic'] = 'true';
    return mod;
  });

const LOCATION_TEXT = 'МУЗРАДАР показывает вас слушателям рядом — приблизительно, в пределах квартала.';

const blockedPermissions = [
  // «только камера»: никакого доступа к медиатеке, даже если его подмешивает библиотека
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.ACCESS_MEDIA_LOCATION',
  // микрофон не нужен
  'android.permission.RECORD_AUDIO',
  // фоновую геолокацию не запрашиваем никогда (Live-режим работает через foreground service)
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  // оверлей нужен только dev-меню
  ...(IS_PROD ? ['android.permission.SYSTEM_ALERT_WINDOW'] : []),
];

export default ({ config }: ConfigContext): ExpoConfig => {
  const expo: ExpoConfig = {
    ...config,
    name: IS_PROD ? 'МУЗРАДАР' : `МУЗРАДАР (${APP_VARIANT})`,
    slug: 'muzradar',
    scheme: 'muzradar',
    version: '0.1.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'dark',
    backgroundColor: '#07070C',
    ios: {
      bundleIdentifier: IS_PROD ? 'app.muzradar' : `app.muzradar.${APP_VARIANT}`,
      supportsTablet: false,
      config: { usesNonExemptEncryption: false },
    },
    android: {
      package: IS_PROD ? 'app.muzradar' : `app.muzradar.${APP_VARIANT}`,
      adaptiveIcon: {
        backgroundColor: '#07070C',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: false,
      blockedPermissions,
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        { backgroundColor: '#07070C', image: './assets/splash-icon.png', imageWidth: 160 },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'Камера нужна только для фото аватара: снимок лица делается один раз при регистрации.',
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: false,
        },
      ],
      [
        'expo-audio',
        {
          microphonePermission: false,
          recordAudioAndroid: false,
          enableBackgroundRecording: false,
          enableBackgroundPlayback: true,
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission: LOCATION_TEXT,
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          isIosBackgroundLocationEnabled: LIVE_LOCATION,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: LIVE_LOCATION,
        },
      ],
      ['expo-secure-store', { configureAndroidBackup: true, faceIDPermission: false }],
      '@maplibre/maplibre-react-native',
    ],
    experiments: { typedRoutes: true },
    extra: {
      // eas init пишет extra.eas.projectId в app.json — не затираем его
      ...config.extra,
      apiUrl: API_URL,
      locationGate: LOCATION_GATE,
      liveLocation: LIVE_LOCATION,
      appVariant: APP_VARIANT,
    },
  };
  return IS_PROD ? expo : withDevCleartext(expo);
};
