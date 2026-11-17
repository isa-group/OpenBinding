/**
 * The Tailwind classes the problem editor's panes and forms are drawn with, named once so the many forms over a package's
 * documents stay alike. Each string is written out whole, so Tailwind finds every class in this file.
 */

/** Every text field, select and text area inside: SPHERE's input look (the forms carry no class of their own on them). */
export const FIELDS = [
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:max-w-full',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:min-w-0',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:rounded-md',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:border',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:border-tp-input-border',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:bg-tp-input-bg',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:px-2.5',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:text-sm',
  '[&_:is(input,select,textarea):not([type=checkbox],[type=radio],[type=range],[type=file])]:text-tp-ink',
  '[&_:is(input,select):not([type=checkbox],[type=radio],[type=range],[type=file])]:h-[38px]',
  '[&_textarea]:min-h-24 [&_textarea]:resize-y [&_textarea]:py-2 [&_textarea]:leading-snug',
  '[&_:is(input,select,textarea):disabled]:cursor-not-allowed [&_:is(input,select,textarea):disabled]:bg-tp-surface',
  '[&_:is(input,select,textarea):focus-visible]:outline-2 [&_:is(input,select,textarea):focus-visible]:outline-offset-1 [&_:is(input,select,textarea):focus-visible]:outline-tp-primary',
  '[&_:is(input,textarea)[aria-invalid=true]]:border-tp-severity-error',
  '[&_:is(input[type=checkbox],input[type=radio])]:accent-tp-primary',
  '[&_select]:cursor-pointer',
].join(' ');

// -- The panes

export const PANE = 'flex min-w-0 flex-col gap-4';
export const MUTED = 'text-sm text-tp-slate';
export const NOTE = 'text-[13px] text-tp-steel';
export const LINK = 'min-h-8 cursor-pointer text-left text-tp-link underline';
export const FIELD = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-tp-steel';
export const FORM_HEAD = 'flex flex-wrap items-center gap-1 [&>code]:font-mono [&>code]:text-xs';

// -- The forms over the documents

export const RESOURCE_FORM = 'flex flex-col gap-6';
export const SECTION = 'flex flex-col rounded-xl border border-tp-hairline-soft bg-tp-canvas';
export const SECTION_IDENTITY = 'border-t-[3px] border-t-tp-primary-deep';
export const SECTION_HEADING =
  'flex flex-wrap items-start justify-between gap-2 border-b border-tp-hairline-soft p-4 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-1 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-tp-ink [&_p]:max-w-[68ch] [&_p]:text-[13px] [&_p]:text-tp-steel';
export const COUNT =
  'min-w-6 rounded-full border border-tp-beige-deep bg-tp-surface-cream px-2 text-center font-mono text-xs font-semibold text-tp-primary-deep';
export const SECTION_BODY = 'flex min-w-0 flex-col gap-4 p-4';
export const MICRO_LABEL = 'text-[11px] font-semibold tracking-[0.14em] text-tp-steel uppercase';

export const CARD_LIST = 'grid gap-2';
export const CARD_LIST_COMPACT =
  'grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-2';
export const TOPOLOGY_LIST =
  'grid gap-2 [&>article]:border-l-[3px] [&>article]:border-l-tp-primary-deep';
export const CARD = 'min-w-0 rounded-xl border border-tp-hairline bg-tp-canvas';
export const CARD_HEADING =
  'flex flex-wrap items-start justify-between gap-1 rounded-t-xl border-b border-tp-hairline-soft bg-tp-surface px-3.5 py-2.5 [&>div:first-child]:flex [&>div:first-child]:min-w-0 [&>div:first-child]:flex-col [&>div:first-child]:gap-0.5 [&_h4]:min-w-0 [&_h4]:text-[15px] [&_h4]:font-semibold [&_h4]:[overflow-wrap:anywhere] [&_h4_code]:font-mono [&_h4_code]:text-tp-primary-deep [&_p]:text-xs [&_p]:text-tp-steel';
export const CARD_ACTIONS = 'flex-none';
export const CARD_BODY = 'flex min-w-0 flex-col gap-2 px-3.5 pt-2 pb-4';
export const TITLE_MUTED = 'text-xs font-medium text-tp-steel';

/** A label holding a field: its name above it. */
export const LABEL = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-tp-steel';
const GRID_LABELS =
  '[&>label]:flex [&>label]:min-w-0 [&>label]:flex-col [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-tp-steel';
export const GRID = `grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-2 ${GRID_LABELS}`;
export const GRID_COMPACT = `grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] gap-2 ${GRID_LABELS}`;
export const NESTED_GRID = `${GRID} rounded-md border-l-[3px] border-l-tp-primary bg-tp-surface-cream p-2`;
export const WIDE = 'col-span-full';
export const ALERT = 'text-xs text-tp-error-text';
export const EMPTY =
  'rounded-md border border-dashed border-tp-hairline-strong px-3.5 py-3 text-[13px] text-tp-slate';
export const ADD_BAR =
  'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-tp-beige-deep bg-tp-surface-cream px-3.5 py-3 [&_small]:text-xs [&_small]:text-tp-steel [&_strong]:text-[13px] [&>div:first-child]:flex [&>div:first-child]:min-w-[180px] [&>div:first-child]:flex-1 [&>div:first-child]:flex-col [&>div:first-child]:gap-0.5';
export const ADD_BAR_FIELDS = `${ADD_BAR} items-end [&>.grid]:min-w-[min(100%,280px)] [&>.grid]:flex-[2_1_280px]`;
export const INLINE_ACTIONS = 'flex flex-wrap gap-1';
/** A checkbox beside its words, inside a grid that would stack a label. */
export const CHECK =
  'flex! flex-row! items-center gap-2! text-[13px]! font-normal! text-tp-ink! [&>input]:h-4 [&>input]:w-4';

export const ADVANCED =
  'border-t border-tp-hairline-soft [&_label]:flex [&_label]:min-w-0 [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-xs [&_label]:font-medium [&_label]:text-tp-steel [&_textarea]:font-mono [&_textarea]:text-xs [&[open]>summary]:mb-1 [&[open]>summary]:text-tp-ink [&>summary]:cursor-pointer [&>summary]:pt-1 [&>summary]:text-xs [&>summary]:font-semibold [&>summary]:text-tp-slate';
export const EXPRESSION =
  'flex flex-col gap-1 [&>label]:flex [&>label]:min-w-0 [&>label]:flex-col [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-tp-steel [&_textarea]:font-mono [&_textarea]:text-xs';
export const LEGEND = 'px-1.5 text-xs font-semibold text-tp-slate';
export const FIELDSET =
  'm-0 flex min-w-0 flex-col gap-1 rounded-md border border-tp-hairline-soft px-2 pt-1 pb-2';
export const REFERENCE = `m-0 min-w-0 rounded-md border border-tp-hairline-soft px-2 pt-1 pb-2 [&_label]:flex [&_label]:min-w-0 [&_label]:flex-col [&_label]:gap-1.5 [&_label]:text-xs [&_label]:font-medium [&_label]:text-tp-steel`;
export const REFERENCE_PAIR = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-2';
export const STACK = 'flex flex-col gap-1';
export const REFERENCE_ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-end gap-1 [&_fieldset]:border-0 [&_fieldset]:p-0';
export const NUMBER_MAP_ROW =
  'grid grid-cols-1 items-end gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_auto] [&>label]:flex [&>label]:min-w-0 [&>label]:flex-col [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-tp-steel';

export const SUBGROUP =
  'flex flex-col gap-1 border-t border-tp-hairline-soft pt-1 first:border-t-0 first:pt-0';
export const QOS_SUBGROUP =
  'flex flex-col gap-1 rounded-md border border-tp-beige-deep bg-tp-surface-cream p-2';
export const SUBGROUP_HEADING =
  'flex flex-wrap items-center justify-between gap-2 [&_h5]:text-sm [&_h5]:font-semibold [&_h5]:text-tp-ink [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5';
export const NESTED_CARD =
  'flex flex-col gap-1 border-l-2 border-tp-hairline-strong bg-tp-surface px-2 py-1';
export const QOS_FIELD = 'flex min-w-0 flex-col gap-1.5 text-xs font-medium text-tp-steel';

const CHOICE =
  'flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-3 [&_small]:text-xs [&_small]:text-tp-steel [&_strong]:text-sm [&_strong]:text-tp-ink [&>input]:mt-[3px] [&>span]:flex [&>span]:flex-col [&>span]:gap-0.5';
export const choiceCard = (selected: boolean) =>
  selected
    ? `${CHOICE} border-tp-primary bg-tp-primary/5 shadow-[inset_3px_0_0_var(--color-tp-primary)]`
    : `${CHOICE} border-tp-hairline bg-tp-canvas`;
export const CHOICE_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-2';
const BALANCE =
  'flex flex-wrap items-center gap-4 rounded-md border-l-[3px] px-3.5 py-3 [&_span]:text-[11px] [&_span]:tracking-[0.06em] [&_span]:text-tp-steel [&_span]:uppercase [&_strong]:font-mono [&_strong]:text-xl [&>div]:flex [&>div]:flex-col [&>p]:flex-[1_1_240px] [&>p]:text-[13px]';
export const balance = (balanced: boolean) =>
  balanced
    ? `${BALANCE} border-l-tp-severity-success bg-tp-severity-success-bg`
    : `${BALANCE} border-l-tp-severity-warning bg-tp-severity-warning-bg`;
export const HINT =
  'border-l-[3px] border-l-tp-primary-deep bg-tp-surface-cream px-4 py-2 text-[13px] [&>p]:mt-1 [&>p]:text-tp-slate';
export const OVERVIEW =
  'grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] rounded-md border border-tp-hairline-soft [&_span]:text-[11px] [&_span]:font-semibold [&_span]:tracking-[0.05em] [&_span]:text-tp-steel [&_span]:uppercase [&_strong]:font-mono [&_strong]:text-[22px] [&>div]:flex [&>div]:flex-col [&>div]:gap-0.5 [&>div]:border-r [&>div]:border-tp-hairline-soft [&>div]:px-4 [&>div]:py-2 [&>div:last-child]:border-r-0';
export const ARROW = 'mx-2 text-tp-steel';
export const PANEL =
  'flex flex-col gap-2 border-l-[3px] border-l-tp-primary-deep bg-tp-surface-cream px-4 py-2';
