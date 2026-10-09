import type { ReactNode } from 'react';
import './Chip.css';

interface ChipProps {
  children: ReactNode;
  /** `plain` is a quiet label, `accent` the brand tint, `success` and `warning` carry a verdict. */
  tone?: 'plain' | 'accent' | 'success' | 'warning';
  /** Set in monospace, for digests and identifiers. */
  mono?: boolean;
}

/** A small rounded label. */
export function Chip({ children, tone = 'plain', mono = false }: ChipProps) {
  return <span className={`ui-chip ui-chip-${tone}${mono ? ' is-mono' : ''}`}>{children}</span>;
}
