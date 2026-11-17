// The class lists the engine screens share, so a form, a section and a footnote read the same on every page.

/** Muted small text, as the engine screens write their footnotes. */
export const MUTED = 'text-xs text-tp-steel';
/** The small label above a group of fields. */
export const FIELD_LABEL = 'text-xs font-medium text-tp-steel';
/** What is wrong with a field, under it. */
export const FIELD_ERROR = 'text-xs text-tp-error-text';
/** A label that holds its own input, stacked. */
export const STACKED = 'flex min-w-0 flex-col gap-1 text-xs font-medium text-tp-steel';
/** The compact input of a dense row (options, ceilings, paths). */
export const INPUT =
  'box-border min-h-9 w-full rounded-md border border-tp-input-border bg-tp-input-bg px-2.5 text-[13px] font-normal text-tp-ink focus:border-tp-primary focus:outline-none disabled:opacity-60 aria-invalid:border-tp-severity-error';
/** A group of fields stacked with room between them. */
export const BLOCK = 'flex min-w-0 flex-col gap-2';
/** A folded section ("Other capabilities", "Start from a manifest file"). */
export const MORE =
  'rounded-xl border border-tp-hairline-soft open:flex open:flex-col open:gap-2 open:pb-3 [&>:not(summary)]:mx-3.5';
export const MORE_SUMMARY = 'cursor-pointer px-3.5 py-2.5 text-sm font-medium text-tp-ink';
/** The fields of a form laid out in columns that wrap. */
export const GRID = 'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]';

/** A card of a page: a titled section on the canvas. */
export const CARD = 'flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5';
/** The title of a card. */
export const CARD_TITLE = 'text-base font-semibold text-tp-ink';
