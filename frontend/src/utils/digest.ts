/** A digest as the gateway writes it: `sha256-` followed by 64 lowercase hexadecimal characters. */
export const DIGEST_PATTERN = /^sha256-[0-9a-f]{64}$/;

/**
 * Spell a digest the way the resolver does: trimmed, lower case, `sha256:` read as `sha256-`
 * and a bare 64-character hexadecimal string gaining its prefix. The result may still be
 * malformed; check it with {@link isDigest}.
 */
export function normalizeDigest(raw: string): string {
  const cleaned = raw.trim().toLowerCase();
  if (cleaned.startsWith('sha256:')) return `sha256-${cleaned.slice(7)}`;
  if (!cleaned.startsWith('sha256-') && /^[0-9a-f]{64}$/.test(cleaned)) return `sha256-${cleaned}`;
  return cleaned;
}

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}
