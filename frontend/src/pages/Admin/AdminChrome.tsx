import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Action } from '../../components/ui/Action';
import { ErrorState } from '../../components/ui/ErrorState';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { Crumbs } from '../Engines/EngineParts';
import { ADMIN_SECTIONS, type AdminSection, type ChipTone, type Failure } from './adminModel';
import './AdminScreens.css';

/** Administration is for platform administrators: anyone else gets the 403 and no request is made on their behalf. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <div className="adm-page">
        <ErrorState variant="403" layout="page" title="Not available (403)" code="forbidden">
          This page is for platform administrators. It doesn’t appear in your navigation.
        </ErrorState>
      </div>
    );
  }
  return <>{children}</>;
}

interface Crumb {
  label: string;
  to?: string;
  mono?: boolean;
}

interface FrameProps {
  section: AdminSection;
  /** The crumbs after “Home”; the last one is the page itself. */
  trail: Crumb[];
  title: ReactNode;
  lede?: ReactNode;
  /** Chips next to the headline (role, status…). */
  badges?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/** What every administration screen shares: where it sits, the platform-admin bar with the section pills, and the headline. */
export function AdminFrame({ section, trail, title, lede, badges, actions, children }: FrameProps) {
  return (
    <div className="adm-page">
      <Crumbs items={[{ label: 'Home', to: '/app' }, ...trail]} />
      <div className="adm-bar">
        <span className="adm-admin-chip">Platform admin</span>
        <nav aria-label="Administration" className="adm-nav">
          {ADMIN_SECTIONS.map((item) => (
            item.id === section
              ? <span key={item.id} aria-current="page">{item.label}</span>
              : <Link key={item.id} to={item.to} viewTransition>{item.label}</Link>
          ))}
        </nav>
      </div>
      <header className="adm-header">
        <div className="adm-header-copy">
          <div className="adm-title-line">
            <h1>{title}</h1>
            {badges}
          </div>
          {lede && <p>{lede}</p>}
        </div>
        {actions && <div className="adm-header-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** A small rounded label; `dark` is the platform-admin chip’s ink. */
export function Tag({ tone = 'plain', mono = false, children }: { tone?: ChipTone; mono?: boolean; children: ReactNode }) {
  return <span className={`adm-tag is-${tone}${mono ? ' is-mono' : ''}`}>{children}</span>;
}

/** A horizontal meter. Decorative: the figure beside it is what assistive technology reads. */
export function Meter({ value, tone = 'info' }: { value: number; tone?: 'info' | 'success' | 'warning' | 'error' | 'muted' }) {
  const width = Math.max(0, Math.min(100, value));
  return (
    <span className="adm-meter" aria-hidden="true">
      <span className={`is-${tone}`} style={{ width: `${width}%` }} />
    </span>
  );
}

/** A failure as a notice, with the way to try again when there is one. */
export function FailureNotice({ failure, onRetry, retryLabel = 'Try again', className }: { failure: Failure; onRetry?: () => void; retryLabel?: string; className?: string }) {
  return (
    <Notice
      tone={failure.tone}
      title={failure.title}
      className={className}
      action={failure.status === 401
        ? <Action size="sm" variant="secondary" to="/login">Log in again</Action>
        : onRetry && failure.status !== 403 ? <Action size="sm" variant="secondary" onClick={onRetry}>{retryLabel}</Action> : undefined}
    >
      {failure.text}
    </Notice>
  );
}

interface PagerProps {
  offset: number;
  limit: number;
  total: number;
  shown: number;
  onPage: (offset: number) => void;
  noun: string;
}

/** Previous and Next over a server-paged list, with where the page sits. */
export function Pager({ offset, limit, total, shown, onPage, noun }: PagerProps) {
  const first = total === 0 ? 0 : offset + 1;
  const last = offset + shown;
  return (
    <div className="adm-pager">
      <span>{total === 0 ? `No ${noun}` : `Showing ${first.toLocaleString('en-US')}–${last.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}`}</span>
      <span className="adm-pager-buttons">
        <Action size="sm" variant="secondary" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</Action>
        <Action size="sm" variant="secondary" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</Action>
      </span>
    </div>
  );
}
