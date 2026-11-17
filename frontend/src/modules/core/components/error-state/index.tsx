import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCountdown } from '../../hooks/useCountdown';

/** The failures the platform tells apart, by HTTP status. */
export type ErrorVariant = '401' | '402' | '403' | '404' | '429' | '503';

interface Preset {
  /** `error name · detail`, the machine-readable line next to the status chip. */
  code: string;
  title: string;
  body: string;
}

/**
 * Default wording of each variant. A screen that knows more (which organization, which limit, which
 * permission) passes its own `title`, `code` and children; the preset is what an unexplained failure says.
 */
const PRESETS: Record<ErrorVariant, Preset> = {
  '401': {
    code: 'unauthorized · invalid_token',
    title: 'Your session ended',
    body: 'We first try to renew it silently with one refresh request. If that fails, you log in again and come back to the page you were on.',
  },
  '402': {
    code: 'quota_exceeded',
    title: 'You’ve used all of an allowance',
    body: 'Waiting won’t help until you free something or your plan changes, and reducing the size of the request doesn’t either: this is a limit of your plan that was reached.',
  },
  '403': {
    code: 'forbidden',
    title: 'You can’t do this',
    body: 'Your account or credential is valid, but it doesn’t include what this needs. Retrying won’t change that.',
  },
  '404': {
    code: 'not_found',
    title: 'Not found',
    body: 'There’s nothing here you can open. The same message appears whether it doesn’t exist or isn’t yours, so it never reveals that something private exists.',
  },
  '429': {
    code: 'concurrency_limit_exceeded',
    title: 'All your run slots are busy',
    body: 'Every concurrent slot is in use. A slot frees up as soon as one of your runs finishes, so waiting helps here.',
  },
  '503': {
    code: 'unavailable',
    title: 'This isn’t available right now',
    body: 'A service OpenBinding depends on didn’t answer. This says nothing about your account or your plan. Try again in a moment; nothing retries automatically.',
  },
};

const ACTIONS = 'flex flex-wrap items-center gap-2';

const BUTTON =
  'inline-flex h-[34px] cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium no-underline disabled:cursor-not-allowed';

/** How each tone of action is drawn. */
const ACTION: Record<'primary' | 'secondary' | 'link', string> = {
  primary: `${BUTTON} border-tp-accent bg-tp-accent text-tp-on-primary hover:enabled:border-tp-accent-hover hover:enabled:bg-tp-accent-hover disabled:border-transparent disabled:bg-tp-accent/50`,
  secondary: `${BUTTON} border-tp-hairline-strong bg-tp-canvas text-tp-ink hover:enabled:border-tp-stone hover:enabled:bg-tp-surface`,
  link: 'inline-flex cursor-pointer items-center text-sm font-medium text-tp-link hover:text-tp-accent-hover',
};

interface StateActionProps {
  children: ReactNode;
  /** `primary` and `secondary` look like buttons; `link` is plain text. */
  tone?: 'primary' | 'secondary' | 'link';
  /** Renders a router link; otherwise a button. */
  to?: string;
  onClick?: () => void;
  disabled?: boolean;
}

/** One action under a state message: a link to another screen, or a button that retries. */
export function StateAction({
  children,
  tone = 'secondary',
  to,
  onClick,
  disabled,
}: StateActionProps) {
  const className = ACTION[tone];
  if (to)
    return (
      <Link className={className} to={to} viewTransition>
        {children}
      </Link>
    );
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

interface ErrorStateProps {
  /** Which failure; also picks the default wording and actions. Omit it for a free-form card (see `status`). */
  variant?: ErrorVariant;
  /** The chip text when it is not a status code (`OPTION_CLAMPED`, `token`). Defaults to the variant. */
  status?: string;
  /** Replaces the preset's machine line. */
  code?: string;
  title?: string;
  /** The explanation; replaces the preset's. */
  children?: ReactNode;
  /** Facts shown between the explanation and the actions: chips, a gauge, a table. */
  details?: ReactNode;
  /** Replaces the default actions; `null` shows none. */
  actions?: ReactNode;
  /** A 429's `Retry-After`: shows a countdown and keeps the retry action disabled until it ends. */
  retryAfter?: number;
  /** What the countdown says when it ends. Defaults to the wording of a busy job slot. */
  retryReadyText?: string;
  /** Retry handler of the 429 and 503 variants. Without it those variants show no retry button. */
  onRetry?: () => void;
  /** A retry is in flight (503). */
  checking?: boolean;
  /** `warning` is for things that are not failures: the card gets the warning border and an outlined chip. */
  tone?: 'default' | 'warning';
  /** `page` centres the state on its own, for a route that has nothing else to show. */
  layout?: 'card' | 'page';
}

function Countdown({
  seconds,
  onRetry,
  doneText,
}: {
  seconds: number;
  onRetry?: () => void;
  doneText: string;
}) {
  const { left, done, restart } = useCountdown(seconds);
  return (
    <>
      <div className="flex items-center gap-3">
        <span
          className="min-w-12 font-mono text-[22px] font-semibold text-tp-ink"
          aria-hidden="true"
        >
          {done ? '0s' : `${left}s`}
        </span>
        <span role="status" className="text-[13px] text-tp-slate">
          {done ? doneText : 'Retry is available when the countdown ends.'}
        </span>
      </div>
      <div className={ACTIONS}>
        <StateAction
          tone="primary"
          disabled={!done}
          onClick={() => {
            onRetry?.();
            restart();
          }}
        >
          Retry now
        </StateAction>
      </div>
    </>
  );
}

/**
 * A failure explained: what happened (headline and status), why, and what to do next. The same component
 * serves a full-page 404 and a card in a list of states; both API error shapes arrive here already
 * turned into the same props, so people never see a raw answer.
 */
export function ErrorState({
  variant,
  status,
  code,
  title,
  children,
  details,
  actions,
  retryAfter,
  retryReadyText = 'A slot may be free now.',
  onRetry,
  checking = false,
  tone = 'default',
  layout = 'card',
}: ErrorStateProps) {
  const preset = variant ? PRESETS[variant] : undefined;
  const chip = status ?? variant ?? '';
  const defaultActions = variant
    ? defaultActionsFor(variant, { onRetry, checking, hasCountdown: retryAfter !== undefined })
    : null;
  const shownActions = actions === undefined ? defaultActions : actions;

  return (
    <article
      className={`flex flex-col gap-2.5 rounded-2xl border bg-tp-canvas ${
        tone === 'warning' ? 'border-tp-severity-warning-border' : 'border-tp-hairline'
      } ${layout === 'page' ? 'mx-auto my-16 w-full max-w-[40rem] p-8' : 'p-[18px]'}`}
      data-tone={tone}
      data-layout={layout}
      aria-label={title ?? preset?.title}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-md px-2 py-px font-mono text-xs ${
            tone === 'warning'
              ? 'border border-tp-warning-strong bg-transparent text-tp-ink'
              : 'bg-tp-ink text-tp-on-primary'
          }`}
        >
          {chip}
        </span>
        {(code ?? preset?.code) && (
          <span className="text-xs [overflow-wrap:anywhere] text-tp-steel">
            {code ?? preset?.code}
          </span>
        )}
      </span>
      <h2
        className={
          layout === 'page'
            ? 'font-display text-[28px] font-normal tracking-tight text-tp-ink'
            : 'text-base leading-snug font-semibold text-tp-ink'
        }
      >
        {title ?? preset?.title}
      </h2>
      {(children ?? preset?.body) && (
        <p className="text-sm text-tp-slate [&_code]:text-[13px]">{children ?? preset?.body}</p>
      )}
      {details}
      {variant === '429' && retryAfter !== undefined && (
        <Countdown seconds={retryAfter} onRetry={onRetry} doneText={retryReadyText} />
      )}
      {checking && (
        <span className="inline-flex items-center gap-2 text-[13px]" role="status">
          <i
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-tp-cream-deeper border-t-tp-primary"
          />
          Checking…
        </span>
      )}
      {shownActions && <div className={ACTIONS}>{shownActions}</div>}
    </article>
  );
}

function defaultActionsFor(
  variant: ErrorVariant,
  options: { onRetry?: () => void; checking: boolean; hasCountdown: boolean }
): ReactNode {
  switch (variant) {
    case '401':
      return (
        <StateAction tone="primary" to="/authentication">
          Log in again
        </StateAction>
      );
    case '402':
      return (
        <>
          <StateAction tone="primary" to="/me/settings?section=plan">
            See your plan
          </StateAction>
          <StateAction to="/pricing">Request an agreement</StateAction>
        </>
      );
    case '403':
    case '404':
      return (
        <StateAction tone="primary" to="/">
          Back to the workspace
        </StateAction>
      );
    case '429':
      // With a countdown the retry button belongs to it; without one, a plain retry.
      return options.hasCountdown || !options.onRetry ? null : (
        <StateAction tone="primary" onClick={options.onRetry}>
          Retry now
        </StateAction>
      );
    case '503':
      return (
        <>
          {options.onRetry && (
            <StateAction onClick={options.onRetry} disabled={options.checking}>
              Try again
            </StateAction>
          )}
          <StateAction tone="link" to="/#service-status">
            Service status
          </StateAction>
        </>
      );
  }
}
