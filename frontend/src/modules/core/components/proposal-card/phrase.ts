// SPHERE's normalisation of a typed confirmation phrase (frontend/src/modules/orbit/components/plan-card.tsx, revision
// 73779a8a, `normalizePhrase`), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT
// licence: the full text is in THIRD_PARTY_NOTICES.md. The gateway compares the same way (`normalise_phrase`).

/** Trimmed, with runs of whitespace as one space, in lower case. */
export const normalisePhrase = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();
