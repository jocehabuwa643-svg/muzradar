const SECRET_KEY = 'muzradar.installSecret.v1';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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

export function getInstallSecret(): Promise<string> {
  if (cachedSecret) return Promise.resolve(cachedSecret);
  pending ??= (async () => {
    let secret = localStorage.getItem(SECRET_KEY);
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(SECRET_KEY, secret);
    }
    cachedSecret = secret;
    return secret;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export function getDeviceHint(): undefined {
  return undefined;
}

export async function forgetInstallSecret(): Promise<void> {
  cachedSecret = null;
  localStorage.removeItem(SECRET_KEY);
}
