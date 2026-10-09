import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { platformApi, type Organization, type Project, type Study } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import type { ProjectAccess } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { StudyFrame, StudyGate } from './parts';

export interface StudyScopeValue {
  organization: Organization;
  project: Project;
  access: ProjectAccess;
  study: Study;
  /** `/app/:org/:project` */
  root: string;
  /** Read the study again after it changed. */
  reloadStudy: () => void;
}

interface LoaderProps {
  organization: Organization;
  project: Project;
  access: ProjectAccess;
  children: (scope: StudyScopeValue) => ReactNode;
}

/** The study named by the address, found in the list of the project (archived ones too): there is no endpoint for one study. */
function StudyLoader({ organization, project, access, children }: LoaderProps) {
  const { study: slug = '' } = useParams();
  const studies = useResource<Study[]>(`studies:${organization.slug}/${project.slug}`, () => platformApi.studies(organization.slug, project.slug, true));
  const root = `/app/${organization.slug}/${project.slug}`;
  const list = studies.data ?? studies.stale;
  const trail = [{ label: 'Studies', to: `${root}/studies` }, { label: slug }];

  if (studies.status === 'loading' && !list) {
    return (
      <StudyFrame organization={organization} project={project} trail={[{ label: 'Studies', to: `${root}/studies` }, { label: 'Loading…' }]}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the study…</span><Skeleton variant="panel" /></div>
      </StudyFrame>
    );
  }
  if (!list) {
    const problem = classifyAuthError(studies.error);
    return (
      <StudyFrame organization={organization} project={project} trail={trail}>
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={studies.reload}>Retry</Action>}>
          {problem.status === 403
            ? `This credential can’t read studies${marker(problem)}. Use a session, or a key with studies:read.`
            : `The study couldn’t be loaded${marker(problem)}.`}
        </Notice>
      </StudyFrame>
    );
  }
  const study = list.find((item) => item.slug === slug);
  if (!study) {
    return (
      <StudyFrame organization={organization} project={project} trail={trail} width="lg">
        <StudyGate title="Study not found" action={<Action to={`${root}/studies`} variant="primary">All studies</Action>}>
          No study with this address in {project.name} (404).
        </StudyGate>
      </StudyFrame>
    );
  }
  return <>{children({ organization, project, access, study, root, reloadStudy: studies.reload })}</>;
}

/**
 * Everything a screen below a study needs before it can draw: the project the address names, and the study in it. A study that isn't
 * there reads the same whether it never existed or belongs to a project the account can't see.
 */
export function StudyScope({ children }: { children: (scope: StudyScopeValue) => ReactNode }) {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <StudyLoader key={`${organization.slug}/${project.slug}`} organization={organization} project={project} access={access}>{children}</StudyLoader>;
}
