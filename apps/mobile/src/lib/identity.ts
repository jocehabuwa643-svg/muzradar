import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const SECRET_KEY = 'muzradar.installSecret.v1';

// Читается и фоновыми задачами при заблокированном экране; не переезжает на другое устройство из бэкапа.
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url без паддинга; 32 байта → 43 символа. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

let cachedSecret: string | null = null;
let pending: Promise<string> | null = null;

/**
 * Секрет установки — единственный долгоживущий ключ аккаунта.
 * iOS: Keychain переживает переустановку. Android: Keystore очищается — тогда помогает deviceHint.
 */
export function getInstallSecret(): Promise<string> {
  if (cachedSecret) return Promise.resolve(cachedSecret);
  pending ??= (async () => {
    let secret = await SecureStore.getItemAsync(SECRET_KEY, SECURE_OPTS);
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      secret = toBase64Url(Crypto.getRandomBytes(32));
      await SecureStore.setItemAsync(SECRET_KEY, secret, SECURE_OPTS);
    }
    cachedSecret = secret;
    return secret;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** Android ID (SSAID): стабилен для пары «ключ подписи + устройство», переживает переустановку. */
export function getDeviceHint(): string | undefined {
  if (Platform.OS !== 'android') return undefined;
  try {
    const raw = Application.getAndroidId();
    if (!raw) return undefined;
    const hex = raw.toLowerCase().padStart(16, '0');
    return /^[0-9a-f]{16}$/.test(hex) ? hex : undefined;
  } catch {
    return undefined;
  }
}

/** Полный сброс (удаление аккаунта): следующий запуск — новый аккаунт. */
export async function forgetInstallSecret(): Promise<void> {
  cachedSecret = null;
  await SecureStore.deleteItemAsync(SECRET_KEY, SECURE_OPTS);
}
