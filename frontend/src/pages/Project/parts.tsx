import type { ReactNode } from 'react';
import type { Organization, Project, Visibility } from '../../api/platform';
import { platformApi } from '../../api/platform';
import { ProjectTabs, type ProjectSection } from '../../components/PlatformShell/ProjectTabs';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
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
      <ProjectTabs active={section} orgSlug={organization.slug} projectSlug={project.slug} />
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

/** A link to the Explore card of a public project: public projects still open here only for members (gap L4), but anyone can see the card. */
function ExploreCardLink({ orgSlug, projectSlug }: { orgSlug: string; projectSlug: string }) {
  const cards = useResource(`explore-card:${orgSlug}/${projectSlug}`, () => platformApi.publicProjects().catch(() => []));
  const isPublic = (cards.data ?? []).some((card) => card.organization.slug === orgSlug && card.project.slug === projectSlug);
  if (!isPublic) return null;
  return <Action to="/explore" variant="link">See its public card in Explore</Action>;
}

interface ProjectGateProps {
  failure: AuthFailure | null;
  orgSlug: string;
  projectSlug: string;
  organizationName?: string;
  onRetry?: () => void;
}

/**
 * Why a project can’t be shown. A missing project and one the account isn’t in read the same (gap L3: the answer must not
 * reveal what exists); a public project still needs membership to open here (gap L4), so its gate points to the Explore card.
 */
export function ProjectGate({ failure, orgSlug, projectSlug, organizationName, onRetry }: ProjectGateProps) {
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
            <ExploreCardLink orgSlug={orgSlug} projectSlug={projectSlug} />
          </>
        )}
      >
        It doesn’t exist, or you’re not a member of its organization. Even public projects open here only for members.
      </Gate>
    </div>
  );
}
