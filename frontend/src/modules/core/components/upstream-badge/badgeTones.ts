// Adapted from SPHERE frontend/src/modules/organization/pages/organization-detail/components/services/badgeTones.ts
// (revision 7c7074ff), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: only the tones the upstream badges use (amber, rose, sky and neutral); the shape is SPHERE's, unchanged. As in
// SPHERE, there are no `dark:` classes: OpenBinding draws the light theme only, whatever the system's.

export const BADGE_TONES = {
  amber: 'border-amber-600 bg-amber-50 text-amber-700',
  rose: 'border-rose-600 bg-rose-50 text-rose-700',
  sky: 'border-sky-600 bg-sky-50 text-sky-700',
  neutral: 'border-tp-hairline-strong bg-tp-surface text-tp-slate',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

/** The shape every badge shares; add a tone from BADGE_TONES. */
export const BADGE_SHAPE =
  'inline-flex items-center rounded-full border px-2 py-px font-sans text-[11px] font-semibold leading-4';
