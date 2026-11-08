import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Unguessable short id for share links (10 chars of base62 ≈ 59 bits). */
export function newId(length = 10) {
  const bytes = randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // Reject values that would bias the distribution (248 = 4 * 62).
    if (bytes[i] < 248) out += ALPHABET[bytes[i] % 62];
  }
  return out.length === length ? out : newId(length);
}

export const ID_PATTERN = /^[0-9A-Za-z]{10}$/;
