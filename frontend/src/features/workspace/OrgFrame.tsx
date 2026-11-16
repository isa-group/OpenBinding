import type { ReactNode } from 'react';
import type { Organization } from '../../api/platform';
import { Action } from '../../modules/core/components/action-button';
import { Skeleton } from '../../modules/core/components/skeleton';
import { Breadcrumb, Gate, type Crumb } from './parts';
import { marker, type AuthFailure } from '../../modules/core/api/errors';
import './workspace.css';

interface OrgFrameProps {
  organization: Organization;
  /** The crumbs after the organization: the last one is where you are. */
  trail?: Crumb[];
  /** Title, chips and actions, in the band under the breadcrumb. */
  header?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'wide';
  /** An extra class for the content column. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The frame of every screen of an organization's workspace: the band with the breadcrumb (and a title, when the screen has one) and
 * the content column. The content column is one live region, so a message that appears is read out.
 */
export function OrgFrame({
  organization,
  trail = [],
  header,
  width = 'wide',
  bodyClassName,
  children,
}: OrgFrameProps) {
  const items: Crumb[] = [
    { label: 'Home', to: '/app' },
    trail.length > 0
      ? { label: organization.name, to: `/app/${organization.slug}` }
      : { label: organization.name },
    ...trail,
  ];
  return (
    <div className="proj-frame">
      <div className={`proj-band${header ? ' has-header' : ''}`}>
        <div className="proj-band-inner">
          <Breadcrumb items={items} />
          {header}
        </div>
      </div>
      <div
        className={`proj-body${bodyClassName ? ` ${bodyClassName}` : ''} is-${width}`}
        aria-live="polite"
      >
        {children}
      </div>
    </div>
  );
}

/** The frame's place while the screen is still finding its organization. */
export function OrgSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="proj-body is-wide" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton variant="panel" />
      <Skeleton variant="card" />
    </div>
  );
}

interface OrgGateProps {
  failure: AuthFailure | null;
  organizationName?: string;
  onRetry?: () => void;
}

/**
 * Why a screen of the workspace can't be shown. A missing organization and one the account isn't in read the same (the answer must
 * not reveal what exists).
 */
export function OrgGate({ failure, organizationName, onRetry }: OrgGateProps) {
  if (failure?.status === 403) {
    return (
      <div className="proj-body is-wide">
        <Gate
          title={`Your role doesn’t reach this${marker(failure)}`}
          action={
            <Action to="/app" variant="primary">
              Back to Home
            </Action>
          }
        >
          This needs a higher role in {organizationName ?? 'the organization'}. Ask one of its
          admins.
        </Gate>
      </div>
    );
  }
  if (failure && failure.status !== 404 && failure.kind !== 'not-found') {
    return (
      <div className="proj-body is-wide">
        <Gate
          title={`The organization couldn’t be loaded${marker(failure)}`}
          action={
            <>
              {onRetry && (
                <Action variant="primary" onClick={onRetry}>
                  Try again
                </Action>
              )}
              <Action to="/app" variant="secondary">
                Back to Home
              </Action>
            </>
          }
        >
          {failure.kind === 'unavailable' || failure.kind === 'network'
            ? 'A service OpenBinding depends on didn’t answer. This says nothing about your access. Try again in a moment.'
            : 'The gateway refused to show it. Try again, or go back to Home.'}
        </Gate>
      </div>
    );
  }
  return (
    <div className="proj-body is-wide">
      <Gate
        title="Organization not available"
        action={
          <Action to="/app" variant="primary">
            Back to Home
          </Action>
        }
      >
        It doesn’t exist, or you’re not a member. We show the same message either way so
        organization names stay private.
      </Gate>
    </div>
  );
}
