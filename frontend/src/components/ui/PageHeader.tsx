import type { ReactNode } from 'react';
import './PageHeader.css';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  /** Buttons aligned with the title, on wide screens to its right. */
  actions?: ReactNode;
}

/** Eyebrow, display headline and lede that open every public screen. */
export function PageHeader({ eyebrow, title, lede, actions }: PageHeaderProps) {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header-copy">
        <span className="ui-page-header-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions && <div className="ui-page-header-actions">{actions}</div>}
    </header>
  );
}
