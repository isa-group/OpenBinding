import type { ReactNode } from 'react';
import './EmptyState.css';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  /** A link or button under the explanation. */
  action?: ReactNode;
  /** A dashed border for "nothing here yet", a solid one for "nothing matches". */
  dashed?: boolean;
}

/** The centred box that says why a list or panel is empty and what to do about it. */
export function EmptyState({ icon, title, children, action, dashed = false }: EmptyStateProps) {
  return (
    <div className={`ui-empty${dashed ? ' is-dashed' : ''}`}>
      <span className="ui-empty-icon" aria-hidden="true">{icon}</span>
      <strong>{title}</strong>
      {children && <span className="ui-empty-text">{children}</span>}
      {action}
    </div>
  );
}
