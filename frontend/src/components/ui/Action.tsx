import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './Action.css';

export type ActionVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost' | 'link';

interface ActionCommon {
  /** `primary` is the one filled action of a view; `danger` confirms something destructive. */
  variant?: ActionVariant;
  /** `sm` 32px, `md` 40px. */
  size?: 'sm' | 'md';
  /** A request is in flight: shows the spinner and refuses further clicks. */
  busy?: boolean;
  children: ReactNode;
}

type ActionButtonProps = ActionCommon & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { to?: undefined };
type ActionLinkProps = ActionCommon & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'href'> & { to: string };

function classes({ variant = 'secondary', size = 'md', busy, className }: Pick<ActionCommon, 'variant' | 'size' | 'busy'> & { className?: string }) {
  return ['ui-action', `is-${variant}`, `is-${size}`, busy ? 'is-busy' : '', className ?? ''].filter(Boolean).join(' ');
}

/** A button, or a router link that looks like one. */
export function Action(props: ActionButtonProps | ActionLinkProps) {
  if (props.to !== undefined) {
    const { to, variant, size, busy, className, children, ...anchor } = props;
    return <Link {...anchor} to={to} viewTransition className={classes({ variant, size, busy, className })}>{children}</Link>;
  }
  const { variant, size, busy, className, children, type = 'button', disabled, ...button } = props;
  return (
    <button {...button} type={type} className={classes({ variant, size, busy, className })} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="ui-action-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
