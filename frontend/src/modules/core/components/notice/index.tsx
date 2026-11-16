// Pattern only, after SPHERE frontend/src/modules/core/components/block-alert/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Drawn with SPHERE's block-alert recipe (rounded-lg bordered box with an icon, severity tokens); the text uses the
// strong severity shades so it reaches 4.5:1. Errors announce themselves; the rest are polite.

import type { ReactNode } from 'react';
import {
  MdCheckCircleOutline,
  MdErrorOutline,
  MdInfoOutline,
  MdWarningAmber,
} from 'react-icons/md';

export type NoticeTone = 'info' | 'error' | 'success' | 'warning';

interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** A button or link, placed after the message. */
  action?: ReactNode;
  className?: string;
}

const ICONS = {
  info: MdInfoOutline,
  error: MdErrorOutline,
  success: MdCheckCircleOutline,
  warning: MdWarningAmber,
} as const;

const TONES = {
  info: 'border-tp-severity-info-border bg-tp-severity-info-bg text-tp-info-text',
  error: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
  success: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warning: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
} as const;

const ICON_TONES = {
  info: 'text-tp-info-strong',
  error: 'text-tp-error-strong',
  success: 'text-tp-success-strong',
  warning: 'text-tp-warning-strong',
} as const;

/** A message that belongs to one place on the page: errors announce themselves, the rest are polite. */
export function Notice({ tone = 'info', title, children, action, className = '' }: NoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div
      className={`ui-notice ui-notice-${tone} flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${TONES[tone]} ${className}`.trim()}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon
        className={`ui-notice-icon mt-0.5 h-4 w-4 shrink-0 ${ICON_TONES[tone]}`}
        aria-hidden="true"
      />
      <div className="ui-notice-body flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <strong className="font-semibold">{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className="ui-notice-action shrink-0">{action}</div>}
    </div>
  );
}
