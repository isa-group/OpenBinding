import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import './Notice.css';

export type NoticeTone = 'info' | 'error' | 'success' | 'warning';

interface NoticeProps {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** A button or link, placed after the message. */
  action?: ReactNode;
  className?: string;
}

const ICONS = { info: Info, error: AlertCircle, success: CheckCircle2, warning: AlertTriangle } as const;

/** A message that belongs to one place on the page: errors announce themselves, the rest are polite. */
export function Notice({ tone = 'info', title, children, action, className = '' }: NoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div className={`ui-notice ui-notice-${tone} ${className}`.trim()} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className="ui-notice-icon" aria-hidden="true" />
      <div className="ui-notice-body">
        {title && <strong>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className="ui-notice-action">{action}</div>}
    </div>
  );
}
