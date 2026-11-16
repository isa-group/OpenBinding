import { pickRequestedVersion } from '../../shared/sphere/requested-version';

/** What a version needs for `?version=` to name it: its id, its label and its ordinal. */
export interface VersionNamed {
  id: string;
  label: string;
  ordinal: number;
}

/**
 * The version a composition page opens with, from `?version=` (an id, a label or an ordinal, as the gateway accepts them).
 * All digits names an ordinal first; anything else goes to SPHERE's rule (an id in any letter case, then the exact
 * label). A version the page does not list, hidden or unknown, falls back to the first one listed without saying why,
 * so a link to a version the reader may not see tells nothing about it.
 */
export function pickVersion<T extends VersionNamed>(
  versions: readonly T[],
  requested: string | null
): T | null {
  if (requested && /^\d+$/.test(requested)) {
    const ordinal = Number(requested);
    const match = versions.find(version => version.ordinal === ordinal);
    if (match) return match;
  }
  const named = versions.map(version => ({ ...version, version: version.label }));
  const picked = pickRequestedVersion(named, requested);
  return picked ? versions[named.indexOf(picked)] : null;
}
