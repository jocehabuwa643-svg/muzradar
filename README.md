# МУЗРАДАР

**Слушай тех, кто рядом.** Гео-социальная сеть и музыкальный радар: каждый слушатель — точка на живой карте, тап по точке — и вы слушаете то же самое.

- Продукт, онбординг и отличия от исходного ТЗ: [docs/PRODUCT.md](docs/PRODUCT.md)
- Архитектура, API, источники музыки, дорожная карта: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Состав

| Пакет | Что внутри |
|---|---|
| `apps/mobile` | Expo SDK 57 (React Native 0.86, dev build), expo-router, MapLibre, expo-audio, expo-camera + ML Kit |
| `apps/server` | Fastify 5 + Socket.IO 4.8, Postgres (drizzle), Redis (опционально), sharp |
| `packages/shared` | zod-контракты API, события реалтайма, geohash и размытие позиции |

## Требования

- Node.js ≥ 22.12 (проверено на 24.16), npm 11.
- Docker, Postgres и Redis для разработки **не нужны**: без `DATABASE_URL` сервер поднимает PGlite в процессе, без `REDIS_URL` держит присутствие в памяти.
- Мобильное приложение собирается как **dev build** (не Expo Go): нативные модули MapLibre, ML Kit и MMKV в Expo Go не работают. Собирать через EAS или на машине с Android SDK / Xcode.
  - Локальная сборка Android из пути с кириллицей и пробелом не пройдёт: Gradle/CMake не переносят такие пути. Для локальной нативной сборки склонируйте репозиторий в ASCII-путь, например `C:\src\muzradar`.

## Быстрый старт

```bash
npm install
```

Сервер (http://localhost:8080, данные dev-БД в `apps/server/.data/`):

```bash
npm run dev:server
```

Сквозная проверка работающего сервера:

```bash
npm run smoke -w @muzradar/server
```

Мобильное приложение: один раз собрать dev client, затем запускать Metro.

```bash
cd apps/mobile && npx eas-cli build --profile development --platform android
```

```bash
npm run dev:mobile
```

Адрес API задаётся при сборке/запуске: `EXPO_PUBLIC_API_URL` (по умолчанию `http://10.0.2.2:8080` — так эмулятор Android видит компьютер). Для телефона в той же сети укажите IP компьютера, например `http://192.168.1.20:8080`.

## PWA и HTTPS preview

PWA использует тот же Fastify backend и Socket.IO, что APK. Соберите web и поднимите один HTTPS-адрес:

```bash
npm run export:web -w @muzradar/mobile
npm run tunnel:up -- localhost
```

`localhost` — localhost.run через SSH без аккаунта. Также поддержаны `cloudflare` и `ngrok` (для ngrok нужен свой токен). Скрипт проверяет секреты из `apps/server/.env`, запускает Fastify с PWA и API, проверяет HTTPS `/health` и обновляет `preview.EXPO_PUBLIC_API_URL` в `apps/mobile/eas.json`. PWA открывается по адресу туннеля, API — по `/v1/...`, realtime — по `/v1/realtime`. Остановка: `npm run tunnel:down`.

PWA требует HTTPS для геолокации и камеры. На web используются MapLibre GL и локальная MediaPipe Face Landmarker; галерея не используется. Геолокация — только в foreground, фоновое аудио зависит от браузера. Для обязательного фонового режима нужен APK. Секрет установки PWA хранится в localStorage этого origin: очистка данных сайта может создать новый аккаунт.

## Флаги сборки

| Переменная | Значения | Смысл |
|---|---|---|
| `LOCATION_GATE` | `hard` (по умолчанию) / `map-only` | Без геолокации блокируется всё приложение или только карта (запасной вариант на случай отказа App Review по 5.1.1) |
| `LIVE_LOCATION` | `1` | Фоновая трансляция позиции через foreground service (фаза 2, нужна декларация в Google Play) |
| `APP_VARIANT` | `development` / `preview` / `production` | Идентификатор бандла и имя приложения |

## Проверки

```bash
npm run typecheck
```

```bash
npm test
```

Проверка Android-манифеста (без Android SDK): после prebuild скрипт убеждается, что медиатека, микрофон и фоновая геолокация вырезаны, а служба `mediaPlayback` на месте.

```bash
npm run verify:android -w @muzradar/mobile
```

## Переменные сервера

См. [apps/server/.env.example](apps/server/.env.example). В продакшене обязательны `DATABASE_URL`, `JWT_SECRET`, `PRESENCE_JITTER_SECRET`, `ANDROID_ID_PEPPER`. Хостинг — в РФ (152-ФЗ: персональные данные граждан РФ собираются в российские базы).
