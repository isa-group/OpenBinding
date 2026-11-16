// Pattern only, after SPHERE frontend/src/modules/beta/components/beta-badge/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's pill recipe (rounded-full, small uppercase text, tinted surface); OpenBinding's variants.

import type { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'accent';
  size?: 'sm' | 'md';
  title?: string;
}

const VARIANTS = {
  default: 'border-tp-hairline bg-tp-surface text-tp-slate',
  success: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warning: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  error: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
  info: 'border-tp-severity-info-border bg-tp-severity-info-bg text-tp-info-text',
  accent: 'border-tp-primary/30 bg-tp-primary/10 text-tp-accent',
} as const;

export function Badge({ children, variant = 'default', size = 'sm', title }: BadgeProps) {
  return (
    <span
      className={`badge badge-${variant} badge-${size} inline-flex items-center rounded-full border font-semibold tracking-wide uppercase ${
        size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[10px]'
      } ${VARIANTS[variant]}`}
      title={title}
    >
      {children}
    </span>
  );
}
