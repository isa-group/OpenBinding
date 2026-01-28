import type { ReactNode } from 'react';
import './Badge.css';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'accent';
  size?: 'sm' | 'md';
  title?: string;
}

export function Badge({ children, variant = 'default', size = 'sm', title }: BadgeProps) {
  return (
    <span className={`badge badge-${variant} badge-${size}`} title={title}>
      {children}
    </span>
  );
}
