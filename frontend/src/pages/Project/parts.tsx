import type { ReactNode } from 'react';
import type { Organization, Project, Visibility } from '../../api/platform';
import { ProjectTabs, type ProjectSection } from '../../components/PlatformShell/ProjectTabs';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { ErrorState } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Breadcrumb, Gate } from '../Organization/parts';
import { marker, type AuthFailure } from './projectErrors';
import { visibilityLabel } from './projectModel';
import './Project.css';

export function VisibilityChip({ visibility }: { visibility: Visibility }) {
  return <Chip tone={visibility === 'public' ? 'success' : 'plain'}>{visibilityLabel(visibility)}</Chip>;
}

interface ProjectFrameProps {
  organization: Organization;
  project: Project;
  section: ProjectSection;
  /** The last crumb when the screen is below the project (`Settings`, `Package`). */
  crumb?: string;
  /** Title, chips and actions of the project, in the band above the tabs. */
  header?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'wide';
  children: ReactNode;
}

/**
 * The frame of every screen of a project: the band with the breadcrumb (and the project’s title on the overview),
 * the project tabs and the content column. The content column is one live region, so a message that appears is read out.
 */
export function ProjectFrame({ organization, project, section, crumb, header, width = 'wide', children }: ProjectFrameProps) {
  const root = `/app/${organization.slug}/${project.slug}`;
  const items = [
    { label: 'Home', to: '/app' },
    { label: organization.name, to: `/app/${organization.slug}` },
    crumb ? { label: project.name, to: root } : { label: project.name },
    ...(crumb ? [{ label: crumb }] : []),
  ];
  return (
    <div className="proj-frame">
      <div className={`proj-band${header ? ' has-header' : ''}`}>
        <div className="proj-band-inner">
          <Breadcrumb items={items} />
          {header}
        </div>
      </div>
      <ProjectTabs active={section} orgSlug={organization.slug} projectSlug={project.slug} access={project.access} />
      <div className={`proj-body is-${width}`} aria-live="polite">{children}</div>
    </div>
  );
}

export function ProjectSkeleton() {
  return (
    <div className="proj-body is-wide" role="status" aria-busy="true">
      <span className="sr-only">Loading project…</span>
      <Skeleton variant="panel" />
      <Skeleton variant="card" />
    </div>
  );
}

interface ProjectGateProps {
  failure: AuthFailure | null;
  orgSlug: string;
  projectSlug: string;
  organizationName?: string;
  onRetry?: () => void;
}

/**
 * Why a project can’t be shown. A missing project and a private one the account isn’t in read the same (the answer must not
 * reveal what exists); a public project doesn’t come here at all, it opens read-only. Too many public reads (429) say when to
 * try again.
 */
export function ProjectGate({ failure, organizationName, onRetry }: ProjectGateProps) {
  if (failure?.status === 429) {
    return (
      <div className="proj-body is-wide">
        <ErrorState
          variant="429"
          status="429"
          code={failure.code ?? 'rate_limit_exceeded'}
          title="You’re reading public projects too fast"
          retryAfter={failure.retryAfter ?? 30}
          retryReadyText="You can try again now."
          onRetry={onRetry}
        >
          Reading other people’s public projects is limited per minute. Nothing is wrong with your account; wait for the countdown and try again.
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
          title={`The project couldn’t be loaded${marker(failure)}`}
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
        title="Project not found"
        action={(
          <>
            <Action to="/app" variant="primary">Back to Home</Action>
            <Action to="/explore" variant="link">Explore public projects</Action>
          </>
        )}
      >
        It doesn’t exist, or it’s private and you’re not a member of its organization.
      </Gate>
    </div>
  );
}

/**
 * Jobs, the package export and the settings are for members: a visitor of a public project is told so, without any hint of
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
