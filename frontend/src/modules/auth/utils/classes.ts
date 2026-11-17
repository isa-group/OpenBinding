// The class recipes the sign-in screens share, from SPHERE's auth forms (frontend/src/modules/auth, revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: THIRD_PARTY_NOTICES.md.
// Small white text sits on `tp-accent` and small coloured text is set in it, so both brand palettes reach 4.5:1.

/** The full-width primary action (a button or a link). */
export const PRIMARY_ACTION =
  'flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-tp-accent px-5 text-sm font-medium text-tp-on-primary shadow-sm transition-colors duration-200 hover:bg-tp-primary-deep disabled:cursor-not-allowed disabled:opacity-50';

/** The full-width secondary action. */
export const SECONDARY_ACTION =
  'flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-tp-input-border bg-tp-canvas px-5 text-sm font-medium text-tp-ink transition-colors duration-200 hover:border-tp-primary';

/** A link inside a sentence or under a form. */
export const TEXT_LINK =
  'cursor-pointer font-medium text-tp-accent underline-offset-2 transition-colors duration-200 hover:text-tp-primary-deep hover:underline';

/** The page heading of a sign-in screen. */
export const TITLE = 'font-display text-3xl tracking-tight text-tp-ink sm:text-4xl';

/** The sentence under the heading. */
export const LEDE = 'mt-2 text-sm leading-6 text-tp-steel';

/** The square tile that carries a screen's icon. */
export const ICON_TILE = 'mb-6 flex h-14 w-14 items-center justify-center rounded-xl bg-tp-surface';
