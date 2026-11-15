import type { ReactNode } from 'react';
import type { Organization, Project } from '../../api/platform';
import { ProjectTabs, type ProjectSection } from '../../components/PlatformShell/ProjectTabs';
import { Action } from '../../components/ui/Action';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Breadcrumb, Gate, type Crumb } from '../../pages/Organization/parts';
import { marker, type AuthFailure } from './errors';
import './workspace.css';

interface OrgFrameProps {
  organization: Organization;
  /** The project the screen belongs to, while screens still live in one: its crumb and its tabs. Without it the frame is the organization's. */
  project?: Project;
  /** The project tab marked current. */
  section?: ProjectSection;
  /** The crumbs after the organization (and the project): the last one is where you are. */
  trail?: Crumb[];
  /** Title, chips and actions, in the band above the tabs. */
  header?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'wide';
  /** An extra class for the content column. */
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * The frame of every screen of an organization's workspace: the band with the breadcrumb (and a title, when the screen has one), the
 * project tabs when the screen is inside a project, and the content column. The content column is one live region, so a message that
 * appears is read out.
 */
export function OrgFrame({ organization, project, section, trail = [], header, width = 'wide', bodyClassName, children }: OrgFrameProps) {
  const orgRoot = `/app/${organization.slug}`;
  const below = Boolean(project) || trail.length > 0;
  const items: Crumb[] = [
    { label: 'Home', to: '/app' },
    below ? { label: organization.name, to: orgRoot } : { label: organization.name },
    ...(project ? [trail.length > 0 ? { label: project.name, to: `${orgRoot}/${project.slug}` } : { label: project.name }] : []),
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
      {project && <ProjectTabs active={section} orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />}
      <div className={`proj-body${bodyClassName ? ` ${bodyClassName}` : ''} is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

/** The frame's place while the screen is still finding its organization (and project). */
export function OrgSkeleton({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="proj-body is-wide" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <Skeleton variant="panel" />
      <Skeleton variant="card" />
    </div>
  );
}

/** What the gate is about: the screens of a project, or of the organization itself. */
export type GateSubject = 'project' | 'organization';

interface OrgGateProps {
  failure: AuthFailure | null;
  subject?: GateSubject;
  organizationName?: string;
  onRetry?: () => void;
}

/**
 * Why a screen of the workspace can't be shown. A missing one and a private one the account isn't in read the same (the answer must not
 * reveal what exists). Too many public reads (429) say when to try again.
 */
export function OrgGate({ failure, subject = 'project', organizationName, onRetry }: OrgGateProps) {
  if (failure?.status === 429) {
    return (
      <div className="proj-body is-wide">
        <ErrorState
          variant="429"
          status="429"
          code={failure.code ?? 'rate_limit_exceeded'}
          title={`You’re reading public ${subject === 'project' ? 'projects' : 'organizations'} too fast`}
          retryAfter={failure.retryAfter ?? 30}
          retryReadyText="You can try again now."
          onRetry={onRetry}
        >
          Reading other people’s public {subject === 'project' ? 'projects' : 'organizations'} is limited per minute. Nothing is wrong with your account; wait for the countdown and try again.
        </ErrorState>
      </div>
    );
  }
  if (failure?.status === 403) {
    return (
      <div className="proj-body is-wide">
        <Gate title={`Your role doesn’t reach this${marker(failure)}`} action={<Action to="/app" variant="primary">Back to Home</Action>}>
          This needs a higher role in {organizationName ?? 'the organization'}. Ask one of its admins.
        </Gate>
      </div>
    );
  }
  if (failure && failure.status !== 404 && failure.kind !== 'not-found') {
    return (
      <div className="proj-body is-wide">
        <Gate
          title={`The ${subject} couldn’t be loaded${marker(failure)}`}
          action={(
            <>
              {onRetry && <Action variant="primary" onClick={onRetry}>Try again</Action>}
              <Action to="/app" variant="secondary">Back to Home</Action>
            </>
          )}
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
        title={subject === 'project' ? 'Project not found' : 'Organization not available'}
        action={(
          <Action to="/app" variant="primary">Back to Home</Action>
        )}
      >
        {subject === 'project'
          ? 'It doesn’t exist, or it’s private and you’re not a member of its organization.'
          : 'It doesn’t exist, or you’re not a member. We show the same message either way so organization names stay private.'}
      </Gate>
    </div>
  );
}

/**
 * Runs, the package export and the settings are for members: a visitor of a public project is told so, without any hint of
 * what is behind them (the same answer the gateway gives), and is offered the way back to what they can read.
 */
export function MembersOnlyGate({ root }: { root: string }) {
  return (
    <div className="proj-body is-wide">
      <Gate title="Members only" action={<Action to={root} variant="primary">Back to the project</Action>}>
        This part of the project is only for members of its organization. You’re viewing a public project read-only.
      </Gate>
    </div>
  );
}
