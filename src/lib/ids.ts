/**
 * Identifier and token generation.
 *
 * Everything here uses crypto.getRandomValues. Nothing user-facing is
 * sequential or guessable, and nothing that acts as a bearer token is ever
 * stored in plaintext (see hashToken).
 */

const UNAMBIGUOUS = "abcdefghjkmnpqrstuvwxyz23456789";

/** A v4 UUID, used for user_id and other primary keys. */
export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * A short, lowercase, unambiguous code. Used for card shortcodes
 * (wis.ai/c/{shortcode}, SPEC 7.3) and assistant handle suffixes (SPEC 6.2),
 * both of which get read aloud or typed on a phone.
 */
export function shortCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += UNAMBIGUOUS[b % UNAMBIGUOUS.length];
  return out;
}

/** A long, opaque bearer token (sessions, pairing tokens). */
export function bearerToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A 6-digit numeric one-time code for email auth (SPEC 2.1).
 * Rejection-sampled so every code is equally likely.
 */
export function otpCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, "0");
}

/** SHA-256 hex. Bearer tokens are stored hashed, never in plaintext. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison, for comparing a submitted OTP against
 * the stored one. Avoids leaking position of the first mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
