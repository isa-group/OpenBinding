// Adapted from SPHERE frontend/src/modules/pricing-editor/services/pricing-fragment.ts and the encoder of
// frontend/src/modules/pricing-editor/services/export.service.ts (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the fragment key is `composition` and the wording names a composition; `compositionFragment` writes the
// fragment that `readCompositionFragment` reads.

import LZString from 'lz-string';

/**
 * A Composition2Yaml document passed to an editor in the URL fragment:
 *
 *   …#composition=<LZString.compressToEncodedURIComponent(yaml)>
 *
 * Browsers never send the fragment to a server (not in the request, not in the
 * Referer header), so a composition opened this way reaches neither the
 * gateway's nor any proxy's logs. The value is always the encoded YAML itself,
 * never a short-link key: a key would have to be resolved by the API.
 *
 * Other `key=value` pairs may share the fragment (`#composition=...&foo=bar`);
 * only `composition` is read.
 */
export const COMPOSITION_FRAGMENT_KEY = 'composition';

export type CompositionFragment =
  /** The fragment has no `composition` key: the editor loads what it would load anyway. */
  | { status: 'absent' }
  | { status: 'ok'; yaml: string }
  /** `composition` is present but cannot be decoded; `error` is meant for the user. */
  | { status: 'invalid'; error: string };

/** The characters `compressToEncodedURIComponent` writes (a space is a `+` that went through form decoding). */
const ENCODED_URI_COMPONENT_ALPHABET = /^[A-Za-z0-9+\-$ ]+$/;

const INVALID_PREFIX = 'The composition in this link could not be read';

/** The fragment, with its `#`, that carries `yaml` compressed: what a share link appends to the page's URL. */
export function compositionFragment(yaml: string): string {
  return `#${COMPOSITION_FRAGMENT_KEY}=${LZString.compressToEncodedURIComponent(yaml)}`;
}

/**
 * Reads the composition from a URL fragment (`location.hash`, with or without
 * the leading `#`). Pure: it neither touches the location nor stores anything.
 *
 * Decoding cannot always tell a truncated value from a complete one: a cut link
 * usually decodes to nothing (reported here), but one cut in its last characters
 * may still decode, whole or in part; the editor's own checks then report what
 * is missing.
 */
export function readCompositionFragment(hash: string): CompositionFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);

  if (!params.has(COMPOSITION_FRAGMENT_KEY)) {
    return { status: 'absent' };
  }

  const encoded = params.get(COMPOSITION_FRAGMENT_KEY) ?? '';

  if (encoded.trim() === '') {
    return { status: 'invalid', error: `${INVALID_PREFIX}: it carries no composition.` };
  }

  if (!ENCODED_URI_COMPONENT_ALPHABET.test(encoded)) {
    return {
      status: 'invalid',
      error: `${INVALID_PREFIX}: it is not lz-string compressToEncodedURIComponent output.`,
    };
  }

  let yaml: string | null;
  try {
    yaml = LZString.decompressFromEncodedURIComponent(encoded);
  } catch {
    yaml = null;
  }

  // lz-string answers a damaged or cut value with `null`, an exception or an
  // empty string, depending on where the damage is.
  if (!yaml) {
    return {
      status: 'invalid',
      error: `${INVALID_PREFIX}: it is damaged or incomplete. Open it again from where it came from.`,
    };
  }

  if (yaml.trim() === '') {
    return { status: 'invalid', error: `${INVALID_PREFIX}: it carries no composition.` };
  }

  return { status: 'ok', yaml };
}

/**
 * The current URL without its fragment, for `history.replaceState`. The query
 * string is kept so that the editor's other parameters stay as they were.
 */
export function urlWithoutFragment(location: Pick<Location, 'pathname' | 'search'>): string {
  return location.pathname + location.search;
}

/**
 * Reads the composition fragment of the current page and, when there is one
 * (valid or not), removes it from the address bar and from the current
 * session-history entry straight away, so a later copy of the URL, a bookmark
 * or a reload no longer carries the composition.
 *
 * `history.state` is kept as it is: React Router stores its own `key`/`idx` in
 * it, and replacing it with `null` would make it lose track of this entry.
 *
 * What this cannot undo: the browser's global history (the list of visited
 * pages, address-bar suggestions and anything synced from them) recorded the
 * URL with its fragment when the page was opened, and extensions allowed to
 * read tab URLs could have seen it.
 */
export function takeCompositionFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState' | 'state'>
): CompositionFragment {
  const fragment = readCompositionFragment(location.hash);

  if (fragment.status !== 'absent') {
    history.replaceState(history.state, '', urlWithoutFragment(location));
  }

  return fragment;
}
