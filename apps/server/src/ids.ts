import { createHash, createHmac, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Случайная строка из [0-9a-z]; 20 символов ≈ 103 бита. */
export function randomId(length = 20): string {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const b = bytes[i]!;
    // отбрасываем хвост, чтобы не было перекоса распределения (252 = 36 × 7)
    if (b < 252) out += ALPHABET[b % 36];
  }
  return out.length === length ? out : randomId(length);
}

export const newUserId = () => `u_${randomId(20)}`;
export const newDeviceId = () => `d_${randomId(20)}`;

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacHex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}
