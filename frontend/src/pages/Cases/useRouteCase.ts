import { useParams } from 'react-router-dom';
import type { BindingCase, CaseRevision } from '../../api/platform';
import { platformApi } from '../../api/platform';
import { useResource, type Resource } from '../../utils/useResource';
import { classifyAuthError, type AuthFailure } from '../Project/projectErrors';
import { useRouteProject, type RouteProject } from '../Project/useRouteProject';
import { newestFirst } from './casesModel';

export interface RouteCaseContent {
  item: BindingCase;
  /** Newest first. */
  revisions: CaseRevision[];
}

export interface RouteCase extends RouteProject {
  caseSlug: string;
  content: Resource<RouteCaseContent | null>;
  /**
   * The case to draw: the one just read, or the previous reading of the same case while it is read again (a screen that
   * reloads after a change keeps what it shows instead of blinking through a skeleton).
   */
  loaded: RouteCaseContent | undefined;
  /** Why the case can't be shown (404 when it is missing), once the gateway has answered. */
  caseFailure: AuthFailure | null;
}

/** The project of the address and, once it is known, the case it names with its revisions. */
export function useRouteCase(): RouteCase {
  const route = useRouteProject();
  const { case: caseSlug = '' } = useParams();
  const { organization, project } = route;
  const ready = Boolean(organization && project);
  const content = useResource<RouteCaseContent | null>(
    `case:${route.orgSlug}/${route.projectSlug}/${caseSlug}:${ready ? 'ready' : 'wait'}`,
    async () => {
      if (!organization || !project) return null;
      const [item, revisions] = await Promise.all([
        platformApi.case(organization.slug, project.slug, caseSlug),
        platformApi.revisions(organization.slug, project.slug, caseSlug),
      ]);
      return { item, revisions: newestFirst(revisions) };
    },
  );
  const stale = content.stale;
  const previous = stale && stale.item.slug === caseSlug ? stale : undefined;
  return {
    ...route,
    caseSlug,
    content,
    loaded: content.data ?? (content.status === 'loading' ? previous : undefined),
    caseFailure: content.status === 'error' ? classifyAuthError(content.error) : null,
  };
}
