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
  /**
   * The organization the address names, when the account is in it. For a visitor of a public project it is a stand-in
   * (its address as the name, no role): the gateway tells a visitor nothing else about the organization.
   */
  organization?: Organization;
  /** The project the address names, once the gateway has answered. */
  project?: Project;
  access: ProjectAccess;
  /** The workspace or the project is still being read. */
  waiting: boolean;
  /** Why the project can't be shown: 404 (not there, or not yours), 403, 429, 503… */
  failure: AuthFailure | null;
  /** Read the project again after it changed. */
  reload: () => void;
}

/** The organization of a project the account only reads: what the project itself says, and no role. */
function visitorOrganization(slug: string, project?: Project): Organization {
  return {
    id: project?.organization_id ?? '',
    slug,
    name: slug,
    parent_id: null,
    billing_sponsor_user_id: '',
    effective_role: null,
    created_at: project?.created_at ?? '',
  };
}

/**
 * The project named by `/app/:org/:project`. The workspace shell falls back to the first organization and project when the
 * address names none the account can see; a screen about one project must not, so it asks the gateway (`GET …/projects/{project}`)
 * and keeps the answer, 404 included: the gateway says the same whether the project is missing or the account is not in it.
 *
 * An account outside the organization asks too: a public project answers with `access: "public_read"` and opens read-only.
 * Anything else (private, missing, no session) reads as before: the gate that reveals nothing. A busy gateway (429) or one
 * that doesn't answer is told apart, because it says nothing about the account's access.
 */
export function useRouteProject(): RouteProject {
  const context = useOutletContext<PlatformOutletContext>();
  const { org: orgSlug = '', project: projectSlug = '' } = useParams();
  const { isAdmin } = useAuth();
  const member = context.organizations.find((item) => item.slug === orgSlug);
  // Until the account's organizations are known, an unlisted organization may still turn out to be one of them.
  const who = member ? 'member' : context.loading ? 'pending' : 'outside';
  const resource = useResource<Project | null>(
    `project:${orgSlug}/${projectSlug}:${who}`,
    async () => (who === 'pending' ? null : platformApi.project(orgSlug, projectSlug)),
  );
  const project = (resource.data ?? (resource.status === 'error' ? null : resource.stale)) ?? undefined;
  const failure = resource.status === 'error' ? classifyAuthError(resource.error) : null;
  const neutral = failure !== null && (failure.status === 401 || failure.status === 403 || failure.status === 404 || failure.kind === 'not-found');

  let organization = member;
  if (!organization && project?.access === 'public_read') organization = visitorOrganization(orgSlug, project);
  // A refusal that is not about access still has to reach the gate, which only shows a failure for an organization it knows.
  else if (!organization && failure && !neutral) organization = visitorOrganization(orgSlug);

  const waiting = who === 'pending' ? true : resource.status === 'loading' && !project;
  return {
    context,
    orgSlug,
    projectSlug,
    organization,
    project,
    access: accessIn(organization ?? { effective_role: null }, isAdmin, project?.access),
    waiting,
    failure,
    reload: resource.reload,
  };
}
