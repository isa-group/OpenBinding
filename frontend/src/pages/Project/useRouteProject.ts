import { useOutletContext, useParams } from 'react-router-dom';
import type { Organization, Project } from '../../api/platform';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, type AuthFailure } from './projectErrors';
import { accessIn, type ProjectAccess } from './projectModel';

export interface RouteProject {
  context: PlatformOutletContext;
  orgSlug: string;
  projectSlug: string;
  /** The organization the address names, when the account is in it. */
  organization?: Organization;
  /** The project the address names, once the gateway has answered. */
  project?: Project;
  access: ProjectAccess;
  /** The workspace or the project is still being read. */
  waiting: boolean;
  /** Why the project can't be shown: 404 (not there, or not yours), 403, 503… */
  failure: AuthFailure | null;
  /** Read the project again after it changed. */
  reload: () => void;
}

/**
 * The project named by `/app/:org/:project`. The workspace shell falls back to the first organization and project when the
 * address names none the account can see; a screen about one project must not, so it asks the gateway (`GET …/projects/{project}`)
 * and keeps the answer, 404 included: the gateway says the same whether the project is missing or the account is not in it.
 */
export function useRouteProject(): RouteProject {
  const context = useOutletContext<PlatformOutletContext>();
  const { org: orgSlug = '', project: projectSlug = '' } = useParams();
  const { isAdmin } = useAuth();
  const organization = context.organizations.find((item) => item.slug === orgSlug);
  const resource = useResource<Project | null>(
    `project:${orgSlug}/${projectSlug}:${organization ? 'member' : 'outside'}`,
    () => (organization ? platformApi.project(orgSlug, projectSlug) : Promise.resolve(null)),
  );
  const project = (resource.data ?? (resource.status === 'error' ? null : resource.stale)) ?? undefined;
  const waiting = !organization ? context.loading : resource.status === 'loading' && !project;
  const failure = resource.status === 'error' ? classifyAuthError(resource.error) : null;
  return {
    context,
    orgSlug,
    projectSlug,
    organization,
    project,
    access: accessIn(organization ?? { effective_role: null }, isAdmin),
    waiting,
    failure,
    reload: resource.reload,
  };
}
