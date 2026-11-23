// Session access code (= TOKIMEKI_SESSION_TOKEN; **not** TOKIMEKI_PASSCODE).
// The hub generates a random 6-8 digit numeric code; the relay/CLI treat it as
// an opaque string.
export const SESSION_TOKEN_PATTERN = /^[0-9]{6,8}$/u;

/** Random length 6-8, digits via rejection sampling (avoid modulo bias). */
export function generateSessionToken(): string {
  const lengthBytes = new Uint8Array(1);
  let lengthIndex = 255;
  // 255 is the only byte rejected: 3 divides 255, so each length is uniform.
  while (lengthIndex >= 255) {
    crypto.getRandomValues(lengthBytes);
    lengthIndex = lengthBytes[0] ?? 255;
  }
  const length = 6 + (lengthIndex % 3);
  const bytes = new Uint8Array(16);
  let out = "";
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (out.length >= length) break;
      // 250 = floor(256 / 10) * 10
      if (byte >= 250) continue;
      out += String(byte % 10);
    }
  }
  return out;
}

export function isValidSessionToken(value: string): boolean {
  return SESSION_TOKEN_PATTERN.test(value);
}

// Session passcode (= TOKIMEKI_PASSCODE, not the session token): exactly 6
// digits, generated on the hub and hand-typeable by the receiver.
export const PASSCODE_PATTERN = /^[0-9]{6}$/u;

/** Exactly 6 digits via rejection sampling (no modulo bias). */
export function generatePasscode(): string {
  const bytes = new Uint8Array(16);
  let out = "";
  while (out.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (out.length >= 6) break;
      if (byte >= 250) continue;
      out += String(byte % 10);
    }
  }
  return out;
}

export function isValidPasscode(value: string): boolean {
  return PASSCODE_PATTERN.test(value);
}

export { generateWordSlug } from "../../../../src/lib/word-slug";
