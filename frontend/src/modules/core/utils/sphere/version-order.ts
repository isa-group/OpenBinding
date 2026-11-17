// Copied verbatim from SPHERE frontend/src/modules/pricing/utils/version-order.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

/** Insertion order in SPHERE; createdAt is only a fallback for older API responses. */
export function versionAddedTime(version: {
  addedAt?: string | null;
  createdAt?: string | null;
}): number {
  const time = Date.parse(version.addedAt ?? version.createdAt ?? '');
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

export function compareVersionsOldestFirst(
  a: { id: string; addedAt?: string | null; createdAt?: string | null },
  b: { id: string; addedAt?: string | null; createdAt?: string | null }
): number {
  const first = versionAddedTime(a);
  const second = versionAddedTime(b);
  return (first === second ? 0 : first < second ? -1 : 1) || a.id.localeCompare(b.id);
}
