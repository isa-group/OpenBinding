import { isDigest, normalizeDigest } from '../../utils/digest';
import { isKnownKind } from './resolveModel';

/** What a person typed or pasted in the `Link or digest` field. */
export interface VerifyInput {
  /** The resolver kind a pasted permanent link names, when it names one. */
  kind: string | null;
  /** The digest as typed (not yet normalized), or an empty string. */
  digest: string;
}

const LINKED_KIND = /^\/(?:resolve|verify)\/([A-Za-z-]+)\/([^/]+)\/?$/;

/**
 * A permanent link (`https://host/resolve/<kind>/<digest>` or the `/verify/...` form), a link with a `digest` query
 * (`/app/verifier?digest=D`, `/verify?digest=D`) or a bare digest.
 */
export function parseVerifyInput(raw: string): VerifyInput {
  const text = raw.trim();
  if (/^(?:https?:\/\/|\/)/i.test(text)) {
    try {
      const url = new URL(text, 'http://verify.invalid');
      const linked = LINKED_KIND.exec(url.pathname);
      if (linked) {
        const kind = linked[1].toLowerCase();
        if (isKnownKind(kind)) return { kind, digest: decodeURIComponent(linked[2]) };
      }
      const digest = url.searchParams.get('digest');
      if (digest) return { kind: null, digest };
    } catch {
      // Not a link after all: it is checked as a digest, and refused as one.
    }
  }
  return { kind: null, digest: text };
}

/** The address of a lookup by kind and digest: the digest in its canonical spelling when it is well formed. */
export function lookupPath(kind: string, digest: string): string {
  const normalized = normalizeDigest(digest);
  return `/verify/${kind}/${isDigest(normalized) ? normalized : encodeURIComponent(digest.trim())}`;
}

/** The address that checks a digest of no known kind (signed in: the verifier runs on arrival). */
export function digestPath(digest: string): string {
  const normalized = normalizeDigest(digest);
  return `/verify?digest=${isDigest(normalized) ? normalized : encodeURIComponent(digest.trim())}`;
}
