// The recipes the study screens share, after SPHERE's cards, selects and small buttons (the composition card page's).

/** A card of a tab: SPHERE's `rounded-xl border-tp-hairline bg-tp-canvas`. */
export const CARD = 'rounded-xl border border-tp-hairline bg-tp-canvas p-4';

/** The heading of a card. */
export const CARD_TITLE = 'text-sm font-semibold text-tp-ink';

/** A muted line under a heading or below a table. */
export const MUTED = 'text-xs text-tp-steel';

/** A labelled native select, as the composition page's version select. */
export const SELECT =
  'h-8 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none';

/** The label above a select or an input. */
export const FIELD_LABEL = 'flex flex-col gap-1 text-[11px] font-medium text-tp-steel';

/** A text input or textarea. */
export const INPUT =
  'w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 py-2 text-sm text-tp-ink outline-none transition-colors focus:border-tp-primary disabled:cursor-not-allowed disabled:opacity-50';

/** A link in running text. */
export const LINK = 'cursor-pointer font-medium text-tp-accent underline-offset-2 hover:underline';

/** A small bordered button. */
export const SMALL_BUTTON =
  'inline-flex cursor-pointer items-center gap-1 rounded-md border border-tp-hairline-strong bg-tp-canvas px-3 py-1.5 text-xs text-tp-slate transition-colors hover:bg-tp-surface disabled:cursor-default disabled:opacity-40';
