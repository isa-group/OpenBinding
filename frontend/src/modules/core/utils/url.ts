/**
 * An address that came from outside the application (the gateway, a document someone edited) as something safe to put in an
 * `href`: only `http:` and `https:` pass. A `javascript:` or `data:` address, a relative path and anything that is not a URL
 * come back as `undefined`, so the caller draws no link at all.
 */
export function safeExternalHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const address = value.trim();
  try {
    const { protocol } = new URL(address);
    return protocol === 'https:' || protocol === 'http:' ? address : undefined;
  } catch {
    return undefined;
  }
}
