// Adapted from SPHERE frontend/src/modules/presentation/pages/changelog/types.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's release shape (`content/changelog.json`): a version, a date (or `Unreleased`), a title and a flat
// list of changes, with the stream it was released in; no commit id and no features/fixes sections.

export interface Release {
  version: string;
  /** `YYYY-MM-DD`, or a word such as `Unreleased`. */
  date: string;
  title: string;
  changes: readonly string[];
}

/** A release with the stream of `changelog.json` it belongs to (`platform`, `bim`, `documentation`). */
export interface StreamRelease extends Release {
  stream: string;
}

/** Release streams by name, as written to `changelog.json`. */
export type ChangelogData = Readonly<Record<string, readonly Release[]>>;
