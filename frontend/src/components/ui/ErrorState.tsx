import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCountdown } from './useCountdown';
import './ErrorState.css';

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
    body: 'Waiting won’t help until the allowance renews, and reducing the size of the request doesn’t either: this is a count that ran out.',
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
    title: 'All your job slots are busy',
    body: 'Every concurrent slot your plan allows is in use. If a monthly quota were also exhausted you’d see the 402 instead, because waiting wouldn’t help.',
  },
  '503': {
    code: 'unavailable',
    title: 'This isn’t available right now',
    body: 'A service OpenBinding depends on didn’t answer. This says nothing about your account or your balance. Try again in a moment; nothing retries automatically.',
  },
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
export function StateAction({ children, tone = 'secondary', to, onClick, disabled }: StateActionProps) {
  const className = `ui-state-action is-${tone}`;
  if (to) return <Link className={className} to={to} viewTransition>{children}</Link>;
  return <button type="button" className={className} onClick={onClick} disabled={disabled}>{children}</button>;
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
  /** Retry handler of the 429 and 503 variants. Without it those variants show no retry button. */
  onRetry?: () => void;
  /** A retry is in flight (503). */
  checking?: boolean;
  /** `warning` is for things that are not failures: the card gets the warning border and an outlined chip. */
  tone?: 'default' | 'warning';
  /** `page` centres the state on its own, for a route that has nothing else to show. */
  layout?: 'card' | 'page';
}

function Countdown({ seconds, onRetry }: { seconds: number; onRetry?: () => void }) {
  const { left, done, restart } = useCountdown(seconds);
  return (
    <>
      <div className="ui-state-countdown">
        <span className="ui-state-countdown-value" aria-hidden="true">{done ? '0s' : `${left}s`}</span>
        <span role="status">{done ? 'A slot may be free now.' : 'Retry is available when the countdown ends.'}</span>
      </div>
      <div className="ui-state-actions">
        <StateAction tone="primary" disabled={!done} onClick={() => { onRetry?.(); restart(); }}>Retry now</StateAction>
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
  variant, status, code, title, children, details, actions, retryAfter, onRetry, checking = false, tone = 'default', layout = 'card',
}: ErrorStateProps) {
  const preset = variant ? PRESETS[variant] : undefined;
  const chip = status ?? variant ?? '';
  const defaultActions = variant ? defaultActionsFor(variant, { onRetry, checking, hasCountdown: retryAfter !== undefined }) : null;
  const shownActions = actions === undefined ? defaultActions : actions;

  return (
    <article className={`ui-state is-${tone} is-${layout}`} aria-label={title ?? preset?.title}>
      <span className="ui-state-head">
        <span className="ui-state-chip">{chip}</span>
        {(code ?? preset?.code) && <span className="ui-state-code">{code ?? preset?.code}</span>}
      </span>
      <h2 className="ui-state-title">{title ?? preset?.title}</h2>
      {(children ?? preset?.body) && <p className="ui-state-body">{children ?? preset?.body}</p>}
      {details}
      {variant === '429' && retryAfter !== undefined && <Countdown seconds={retryAfter} onRetry={onRetry} />}
      {checking && <span className="ui-state-checking" role="status"><i aria-hidden="true" />Checking…</span>}
      {shownActions && <div className="ui-state-actions">{shownActions}</div>}
    </article>
  );
}

function defaultActionsFor(variant: ErrorVariant, options: { onRetry?: () => void; checking: boolean; hasCountdown: boolean }): ReactNode {
  switch (variant) {
    case '401':
      return <StateAction tone="primary" to="/login">Log in again</StateAction>;
    case '402':
      return (
        <>
          <StateAction tone="primary" to="/app/account/usage">See my usage</StateAction>
          <StateAction to="/pricing">Request an agreement</StateAction>
        </>
      );
    case '403':
    case '404':
      return <StateAction tone="primary" to="/app">Back to the workspace</StateAction>;
    case '429':
      // With a countdown the retry button belongs to it; without one, a plain retry.
      return options.hasCountdown || !options.onRetry ? null : <StateAction tone="primary" onClick={options.onRetry}>Retry now</StateAction>;
    case '503':
      return (
        <>
          {options.onRetry && <StateAction onClick={options.onRetry} disabled={options.checking}>Try again</StateAction>}
          <StateAction tone="link" to="/status">Service status</StateAction>
        </>
      );
  }
}
