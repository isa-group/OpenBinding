// Adapted from SPHERE frontend/src/modules/core/components/action-button/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the white label sits on the accent, which reaches 4.5:1 (SPHERE's primary orange is 3.35:1). OpenBinding's props
// join SPHERE's button as `Action` (variants, sizes, a busy spinner, a router link that looks like a button) and `Button`,
// drawn with the same recipe (`bg-tp-primary hover:bg-tp-primary-deep rounded-md`, on the accent); the `ui-action` classes stay
// as hooks for the screens not yet redrawn, with no style of their own.

import { motion } from 'framer-motion';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export default function ActionButton({
  text,
  onClick,
  disabled = false,
  className = '',
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={{ scale: !disabled ? 1.02 : 1 }}
      transition={{ duration: 0.3, ease: 'easeInOut' }}
      className={`cursor-pointer rounded-md bg-tp-accent px-4 py-2 text-tp-on-primary hover:bg-tp-accent-hover disabled:cursor-not-allowed disabled:bg-tp-accent/50 ${className}`}
    >
      {text}
    </motion.button>
  );
}

export type ActionVariant =
  'primary' | 'secondary' | 'danger' | 'danger-outline' | 'ghost' | 'link';

interface ActionCommon {
  /** `primary` is the one filled action of a view; `danger` confirms something destructive. */
  variant?: ActionVariant;
  /** `sm` 32px, `md` 40px. */
  size?: 'sm' | 'md';
  /** A request is in flight: shows the spinner and refuses further clicks. */
  busy?: boolean;
  children: ReactNode;
}

type ActionButtonProps = ActionCommon &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { to?: undefined };
type ActionLinkProps = ActionCommon &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'href'> & { to: string };

const BASE =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent text-sm leading-tight font-medium whitespace-nowrap no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45';

const VARIANTS: Record<ActionVariant, string> = {
  primary: 'bg-tp-accent text-tp-on-primary hover:bg-tp-accent-hover hover:text-tp-on-primary',
  secondary:
    'border-tp-hairline-strong bg-tp-canvas text-tp-ink hover:border-tp-stone hover:bg-tp-surface hover:text-tp-ink',
  danger: 'bg-tp-error-strong text-tp-on-primary hover:bg-tp-error-text hover:text-tp-on-primary',
  'danger-outline':
    'border-tp-severity-error-border bg-tp-canvas text-tp-error-strong hover:bg-tp-severity-error-bg',
  ghost: 'bg-transparent text-tp-slate hover:bg-tp-surface hover:text-tp-ink',
  link: 'bg-transparent !p-0 !min-h-0 text-tp-link hover:text-tp-accent-hover hover:underline max-sm:!min-h-6',
};

const SIZES = { sm: 'min-h-8 px-3 text-[13px]', md: 'min-h-10 px-4' } as const;

/** The classes of an action: the hook classes the old screens still style, and the recipe. */
function actionClasses({
  variant = 'secondary',
  size = 'md',
  busy,
  className,
}: Pick<ActionCommon, 'variant' | 'size' | 'busy'> & { className?: string }) {
  return [
    'ui-action',
    `is-${variant}`,
    `is-${size}`,
    busy ? 'is-busy' : '',
    BASE,
    SIZES[size],
    VARIANTS[variant],
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

const spinner = (variant: ActionVariant) =>
  `ui-action-spinner h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-t-current motion-reduce:[animation-duration:3s] ${
    variant === 'primary' || variant === 'danger' ? 'border-white/40' : 'border-black/15'
  }`;

/** A button, or a router link that looks like one. */
export function Action(props: ActionButtonProps | ActionLinkProps) {
  if (props.to !== undefined) {
    const { to, variant, size, busy, className, children, ...anchor } = props;
    return (
      <Link
        {...anchor}
        to={to}
        viewTransition
        className={actionClasses({ variant, size, busy, className })}
      >
        {children}
      </Link>
    );
  }
  const {
    variant = 'secondary',
    size,
    busy,
    className,
    children,
    type = 'button',
    disabled,
    ...button
  } = props;
  return (
    <button
      {...button}
      type={type}
      className={actionClasses({ variant, size, busy, className })}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <span className={spinner(variant)} aria-hidden="true" />}
      {children}
    </button>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'small';
  children: ReactNode;
  fullWidth?: boolean;
}

/** OpenBinding's older button API, drawn as an Action. */
export function Button({
  variant = 'primary',
  size = 'md',
  children,
  fullWidth,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  const extra = [
    'btn',
    `btn-${variant}`,
    size === 'lg' ? 'min-h-12 px-6 text-base' : '',
    fullWidth ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={actionClasses({
        variant,
        size: size === 'sm' || size === 'small' ? 'sm' : 'md',
        className: extra,
      })}
      {...props}
    >
      {children}
    </button>
  );
}
