import type { InputHTMLAttributes, ReactNode, Ref } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import './Auth.css';

interface AuthShellProps {
  children: ReactNode;
  /** The "Back" link above the form: the home page by default. */
  backTo?: string;
  backLabel?: string;
  /** Extra state carried to the back link (the page the person was heading to). */
  backState?: unknown;
}

/** The binding diagram drawn on the brand panel: an input, two candidates, a chosen binding and its verdict. */
function BindingDiagram() {
  return (
    <svg className="auth-brand-diagram" width="260" height="150" viewBox="0 0 260 150" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="8" y="60" width="44" height="30" rx="8" />
      <path d="M52 75h24" />
      <rect x="76" y="28" width="44" height="30" rx="8" />
      <rect x="76" y="92" width="44" height="30" rx="8" />
      <path d="M76 75v-32M76 75v32" />
      <path d="M120 43h20v32M120 107h20V75M140 75h18" />
      <rect x="158" y="60" width="44" height="30" rx="8" strokeDasharray="4 3" />
      <path d="M202 75h18" />
      <circle cx="236" cy="75" r="14" />
      <path d="M230 75l4 4 8-8" />
    </svg>
  );
}

/**
 * The split layout of every authentication screen: a brand panel on the left (a banner on narrow screens)
 * and the form on the right. It lives inside the public layout, so the public header stays above it.
 */
export function AuthShell({ children, backTo = '/', backLabel = 'Back', backState }: AuthShellProps) {
  return (
    <div className="auth-split">
      <aside className="auth-brand" aria-hidden="true">
        <span className="auth-brand-orb auth-brand-orb-a" />
        <span className="auth-brand-orb auth-brand-orb-b" />
        <span className="auth-brand-orb auth-brand-orb-c" />
        <div className="auth-brand-body">
          <BindingDiagram />
          <div>
            <div className="auth-brand-name">OpenBinding</div>
            <div className="auth-brand-tagline">Deterministic QoS binding</div>
          </div>
        </div>
        <span className="auth-brand-stripe" />
      </aside>

      <div className="auth-pane">
        <Link className="auth-back" to={backTo} state={backState} viewTransition><ChevronLeft aria-hidden="true" />{backLabel}</Link>
        <div className="auth-banner" aria-hidden="true">OpenBinding</div>
        <div className="auth-pane-body">
          <div className="auth-panel">{children}</div>
        </div>
        <span className="auth-pane-stripe" aria-hidden="true" />
      </div>
    </div>
  );
}

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: string;
  /** A refusal for this field; replaces the hint and marks the input invalid. */
  error?: string;
  /** Marks the input invalid when the refusal is about the form as a whole and has no sentence of its own here. */
  invalid?: boolean;
  hint?: string;
  /** How the hint reads: neutral help, or a confirmation that the value is fine. */
  hintTone?: 'neutral' | 'ok';
  /** Something on the label row's right edge (the "Forgot password?" link). */
  aside?: ReactNode;
  /** Something under the input, before its note (a strength meter). */
  below?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
}

/** A labelled input whose note (hint or error) is announced with it. */
export function AuthField({ id, label, error, invalid, hint, hintTone = 'neutral', aside, below, inputRef, ...input }: AuthFieldProps) {
  const note = error ?? hint;
  const noteId = `${id}-note`;
  return (
    <div className="auth-field">
      <span className="auth-field-head">
        <label htmlFor={id}>{label}</label>
        {aside}
      </span>
      <input
        {...input}
        id={id}
        ref={inputRef}
        aria-invalid={error || invalid ? true : undefined}
        aria-describedby={note ? noteId : undefined}
      />
      {below}
      {note && <span id={noteId} className={`auth-note${error ? ' is-error' : hintTone === 'ok' ? ' is-ok' : ''}`}>{note}</span>}
    </div>
  );
}

/** The 16px spinner shown inside a busy button. */
export function AuthSpinner() {
  return <span className="auth-spinner" aria-hidden="true" />;
}
