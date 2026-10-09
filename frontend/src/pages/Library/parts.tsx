import type { ReactNode } from 'react';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Skeleton } from '../../components/ui/Skeleton';
import { Breadcrumb, Gate, type Crumb } from '../Organization/parts';
import type { Publication } from './libraryModel';
import { kindLabel, libraryPath, PUBLICATION_LABELS } from './libraryModel';
import '../Project/Project.css';
import './Library.css';

interface LibraryFrameProps {
  orgSlug: string;
  /** The organization's name, when the account is in it; `undefined` for someone reading a published version from outside. */
  orgName?: string;
  /** The crumbs below the organization; the last one is where you are. */
  trail: Crumb[];
  width?: 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/** The frame of every organization-level library screen: breadcrumb and one live content column. */
export function LibraryFrame({ orgSlug, orgName, trail, width = 'wide', children }: LibraryFrameProps) {
  const items: Crumb[] = [
    { label: 'Home', to: '/app' },
    // Someone outside the organization knows it only by an id that means nothing to read: no crumb for it.
    ...(orgName ? [{ label: orgName, to: `/app/${orgSlug}` }] : []),
    ...trail,
  ];
  return (
    <div className="proj-frame">
      <div className="proj-band">
        <div className="proj-band-inner"><Breadcrumb items={items} /></div>
      </div>
      <div className={`proj-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

export function LibrarySkeleton() {
  return (
    <div className="proj-body is-wide" role="status" aria-busy="true">
      <span className="sr-only">Loading the library…</span>
      <Skeleton variant="card" />
      <Skeleton variant="panel" />
    </div>
  );
}

export function KindChip({ kind }: { kind: string }) {
  return <Chip tone="accent">{kindLabel(kind)}</Chip>;
}

export function PublicationChip({ state }: { state: Publication }) {
  return <Chip tone={state === 'published' ? 'success' : state === 'withdrawn' ? 'warning' : 'plain'}>{PUBLICATION_LABELS[state]}</Chip>;
}

/** The item, the version or the draft isn't there (or can't be read): the same card either way. */
export function MissingItem({ orgSlug, title, children, canGoBack = true }: { orgSlug: string; title: string; children: ReactNode; canGoBack?: boolean }) {
  return (
    <Gate title={title} action={canGoBack ? <Action to={libraryPath(orgSlug)} variant="primary">Back to the library</Action> : <Action to="/app" variant="primary">Back to Home</Action>}>
      {children}
    </Gate>
  );
}
