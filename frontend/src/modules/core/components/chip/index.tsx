// Pattern only, after SPHERE frontend/src/modules/beta/components/beta-badge/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's pill recipe (rounded-full, text-[10px]); OpenBinding's tones and its monospace option.

import type { ReactNode } from 'react';

interface ChipProps {
  children: ReactNode;
  /** `plain` is a quiet label, `accent` the brand tint, `success` and `warning` carry a verdict. */
  tone?: 'plain' | 'accent' | 'success' | 'warning';
  /** Set in monospace, for digests and identifiers. */
  mono?: boolean;
}

const TONES = {
  plain: 'border-tp-hairline bg-tp-surface text-tp-slate',
  accent: 'border-tp-primary/30 bg-tp-primary/10 text-tp-accent',
  success: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warning: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
} as const;

/** A small rounded label. */
export function Chip({ children, tone = 'plain', mono = false }: ChipProps) {
  return (
    <span
      className={`ui-chip ui-chip-${tone}${mono ? ' is-mono font-mono' : ''} inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-tight font-medium break-all ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}
