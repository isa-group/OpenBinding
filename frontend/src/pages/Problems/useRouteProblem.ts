import { useParams } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import { problemsApi, type Problem, type ProblemRevision } from '../../api/problems';
import { classifyAuthError, type AuthFailure } from '../../shared/api/errors';
import { useResource, type Resource } from '../../utils/useResource';
import { atLeast } from '../Organization/orgModel';
import { useRouteOrganization, type RouteOrganization } from '../Organization/useRouteOrganization';
import { newestFirst } from './problemsModel';

/** What the account may do with the problems of an organization. */
export interface ProblemAccess {
  role: Organization['effective_role'];
  /** Upload, edit and save versions: MEMBER. */
  canCreate: boolean;
  /** Delete: ADMIN. */
  canAdminister: boolean;
}

export function problemAccess(organization: Organization | undefined): ProblemAccess {
  const role = organization?.effective_role ?? null;
  return { role, canCreate: atLeast(role, 'MEMBER'), canAdminister: atLeast(role, 'ADMIN') };
}

export interface RouteProblemContent {
  item: Problem;
  /** Newest first. */
  revisions: ProblemRevision[];
}

export interface RouteProblem extends RouteOrganization {
  caseSlug: string;
  access: ProblemAccess;
  content: Resource<RouteProblemContent | null>;
  /**
   * The problem to draw: the one just read, or the previous reading of the same problem while it is read again (a screen that
   * reloads after a change keeps what it shows instead of blinking through a skeleton).
   */
  loaded: RouteProblemContent | undefined;
  /** Why the problem can't be shown (404 when it is missing), once the gateway has answered. */
  caseFailure: AuthFailure | null;
}

/** The organization of the address and, once it is known, the problem it names with its revisions. */
export function useRouteProblem(): RouteProblem {
  const route = useRouteOrganization();
  const { case: caseSlug = '' } = useParams();
  const { organization } = route;
  const content = useResource<RouteProblemContent | null>(
    `problem:${route.slug}/${caseSlug}:${organization ? 'ready' : 'wait'}`,
    async () => {
      if (!organization) return null;
      const [item, revisions] = await Promise.all([
        problemsApi.get(organization.slug, caseSlug),
        problemsApi.revisions(organization.slug, caseSlug),
      ]);
      return { item, revisions: newestFirst(revisions) };
    }
  );
  const stale = content.stale;
  const previous = stale && stale.item.slug === caseSlug ? stale : undefined;
  return {
    ...route,
    caseSlug,
    access: problemAccess(organization),
    content,
    loaded: content.data ?? (content.status === 'loading' ? previous : undefined),
    caseFailure: content.status === 'error' ? classifyAuthError(content.error) : null,
  };
}
