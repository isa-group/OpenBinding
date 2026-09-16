/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) and SHA-256 digest calculation in TypeScript / Browser.
 */

function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot serialize non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map((key) => {
      const val = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${canonicalize(val)}`;
    });
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

export function canonicalJsonString(data: unknown): string {
  return canonicalize(data);
}

export async function computeCanonicalDigest(data: unknown): Promise<string> {
  const jsonStr = canonicalize(data);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(jsonStr);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

export async function computeRawSha256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}
