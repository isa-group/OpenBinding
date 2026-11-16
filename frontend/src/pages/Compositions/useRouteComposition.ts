import { useParams } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import { compositionsApi } from '../../entities/composition/api';
import { classifyAuthError, type AuthFailure } from '../../shared/api/errors';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import { useResource, type Resource } from '../../utils/useResource';
import { atLeast } from '../Organization/orgModel';
import { useRouteOrganization, type RouteOrganization } from '../Organization/useRouteOrganization';

/** What the account may do with the compositions of an organization. */
export interface CompositionAccess {
  role: Organization['effective_role'];
  /** Create compositions, edit them and seal versions: MEMBER. */
  canCreate: boolean;
  /** Delete, and change who reads a composition: ADMIN. */
  canAdminister: boolean;
}

export function compositionAccess(organization: Organization | undefined): CompositionAccess {
  const role = organization?.effective_role ?? null;
  return { role, canCreate: atLeast(role, 'MEMBER'), canAdminister: atLeast(role, 'ADMIN') };
}

export interface RouteCompositionContent {
  composition: CompositionView;
  /** The revision of the composition a change must name (`If-Match`). */
  etag: string | null;
  /** Light rows, newest first. */
  versions: CompositionVersionView[];
}

export interface RouteComposition extends RouteOrganization {
  compositionSlug: string;
  access: CompositionAccess;
  content: Resource<RouteCompositionContent | null>;
  /** The composition to draw: the one just read, or the previous reading of the same one while it is read again. */
  loaded: RouteCompositionContent | undefined;
  /** Why the composition can't be shown (404 when it is missing or unreadable), once the gateway has answered. */
  failure: AuthFailure | null;
}

/** The organization of the address and, once it is known, the composition it names with its versions. */
export function useRouteComposition(): RouteComposition {
  const route = useRouteOrganization();
  const { composition: compositionSlug = '' } = useParams();
  const { organization } = route;
  const content = useResource<RouteCompositionContent | null>(
    `composition:${route.slug}/${compositionSlug}:${organization ? 'ready' : 'wait'}`,
    async () => {
      if (!organization) return null;
      const [read, versions] = await Promise.all([
        compositionsApi.get(organization.slug, compositionSlug),
        compositionsApi.allVersions(organization.slug, compositionSlug, { order: 'newest' }),
      ]);
      return { composition: read.value, etag: read.etag, versions };
    },
  );
  const stale = content.stale;
  const previous = stale && stale.composition.slug === compositionSlug ? stale : undefined;
  return {
    ...route,
    compositionSlug,
    access: compositionAccess(organization),
    content,
    loaded: content.data ?? (content.status === 'loading' ? previous : undefined),
    failure: content.status === 'error' ? classifyAuthError(content.error) : null,
  };
}
