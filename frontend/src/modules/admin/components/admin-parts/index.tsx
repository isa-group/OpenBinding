// Pattern only, after SPHERE frontend/src/modules/settings/components/AccountSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// SPHERE has no administration frontend. The pieces every section of `/admin` shares are drawn with the recipes of its settings
// sections (a heading with its description, white rounded-xl cards with a hairline border, pills, h-9 inputs) and its pagination.

/* eslint-disable react-refresh/only-export-components -- class names shared by the sections, next to the pieces that use them */
import type { ReactNode } from 'react';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import Pagination from '../../../core/components/pagination';
import type { ChipTone, Failure } from '../../utils/adminModel';

/** Small print beside a figure or under a control. */
export const MUTED = 'text-[13px] text-tp-steel';
/** The label above a field or a group. */
export const LABEL = 'text-xs font-medium text-tp-steel';
/** A text input or a select (SPHERE's h-9 inputs). */
export const INPUT =
  'h-9 w-full rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-sm text-tp-ink placeholder:text-tp-steel focus:border-tp-primary focus:ring-2 focus:ring-tp-primary/20 focus:outline-none aria-[invalid=true]:border-tp-severity-error';
/** A label with a small caption above its control, laid out in a toolbar. */
export const FIELD = 'flex min-w-0 flex-col gap-1';
/** A row of filters or controls that wraps. */
export const TOOLBAR = 'flex flex-wrap items-end gap-3';
/** A definition list of facts, two columns from `sm` up. */
export const FACTS =
  'grid gap-x-6 gap-y-3 sm:grid-cols-2 [&_dd]:mt-0.5 [&_dd]:text-sm [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-tp-steel';
/** The row of a dialog's buttons: Cancel first, the confirmation last. */
export const DIALOG_ACTIONS = 'mt-5 flex flex-wrap items-center justify-end gap-3';
/** A list or a split pane's item that can be picked (pressed). */
export const PICK =
  'flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors aria-pressed:border-tp-primary/40 aria-pressed:bg-tp-primary/5 border-tp-hairline bg-tp-canvas hover:border-tp-stone';

const TAG_TONES: Record<ChipTone, string> = {
  plain: 'border-tp-hairline bg-tp-surface text-tp-slate',
  info: 'border-tp-severity-info-border bg-tp-severity-info-bg text-tp-info-text',
  success: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warning: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  error: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
  dark: 'border-tp-ink bg-tp-ink text-tp-on-dark',
};

/** A small rounded label; `dark` is the ink of a role or a plan that stands out. */
export function Tag({
  tone = 'plain',
  mono = false,
  children,
}: {
  tone?: ChipTone;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] leading-tight font-medium [overflow-wrap:anywhere] ${
        mono ? 'font-mono' : ''
      } ${TAG_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export type MeterTone = 'info' | 'success' | 'warning' | 'error' | 'muted';

/** The fill of a meter or a bar, by tone. */
export const FILL: Record<MeterTone | 'dark', string> = {
  info: 'bg-tp-severity-info',
  success: 'bg-tp-severity-success',
  warning: 'bg-tp-severity-warning',
  error: 'bg-tp-severity-error',
  muted: 'bg-tp-stone',
  dark: 'bg-tp-ink',
};

/** A horizontal meter. Decorative: the figure beside it is what assistive technology reads. */
export function Meter({ value, tone = 'info' }: { value: number; tone?: MeterTone }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <span
      className="block h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-tp-hairline-soft"
      aria-hidden="true"
    >
      <span className={`block h-full rounded-full ${FILL[tone]}`} style={{ width: `${width}%` }} />
    </span>
  );
}

/** A failure as a notice, with the way to try again when there is one. */
export function FailureNotice({
  failure,
  onRetry,
  retryLabel = 'Try again',
}: {
  failure: Failure;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Notice
      tone={failure.tone}
      title={failure.title}
      action={
        failure.status === 401 ? (
          <Action size="sm" variant="secondary" to="/authentication">
            Log in again
          </Action>
        ) : onRetry && failure.status !== 403 ? (
          <Action size="sm" variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Action>
        ) : undefined
      }
    >
      {failure.text}
    </Notice>
  );
}

/** The heading of a section of `/admin`, with what it is for and its actions (SPHERE's settings section header). */
export function SectionHeader({
  title,
  lede,
  actions,
}: {
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-[1_1_24rem]">
        <h2 className="text-lg font-semibold text-tp-ink">{title}</h2>
        {lede && <p className="mt-1 max-w-3xl text-sm text-tp-steel">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A white card of a section, with its heading and what sits beside it. */
export function Card({
  title,
  aside,
  label,
  danger = false,
  children,
}: {
  /** The card's heading; it names the card for assistive technology too. */
  title?: string;
  aside?: ReactNode;
  /** The card's name when it has no heading. */
  label?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title ?? label}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border bg-tp-canvas p-5 ${
        danger ? 'border-tp-severity-error-border' : 'border-tp-hairline'
      }`}
    >
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {title && (
            <h3
              className={`text-base font-semibold ${danger ? 'text-tp-error-strong' : 'text-tp-ink'}`}
            >
              {title}
            </h3>
          )}
          {aside && <span className={MUTED}>{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A loading placeholder that says what is loading. */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

interface PagerProps {
  offset: number;
  limit: number;
  total: number;
  shown: number;
  onPage: (offset: number) => void;
  noun: string;
}

/** Where a server-paged list stands, and SPHERE's pagination over it. */
export function Pager({ offset, limit, total, shown, onPage, noun }: PagerProps) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  const size = Math.max(1, limit);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className={MUTED}>
        {total === 0
          ? `No ${noun}`
          : `Showing ${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}`}
      </span>
      <Pagination
        currentPage={Math.floor(offset / size) + 1}
        totalPages={Math.ceil(total / size)}
        onPageChange={page => onPage((page - 1) * size)}
      />
    </div>
  );
}
