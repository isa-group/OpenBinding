/**
 * A random version-4 UUID. `crypto.randomUUID` exists only in secure contexts (https or localhost), so a page served over plain http
 * on a LAN address would stop at the first idempotency key; `crypto.getRandomValues` works everywhere.
 */
export function randomUUID(): string {
  const webCrypto = typeof crypto === 'undefined' ? undefined : crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    // No Web Crypto at all: an idempotency key only has to differ from the account's other keys.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
