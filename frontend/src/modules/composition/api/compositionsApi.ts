// Adapted from SPHERE frontend/src/modules/pricing/api/pricingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's gateway routes and generated types instead of SPHERE's `/pricings` API; refusals throw the typed
// error `readApiError` reads; a list is named by its gateway parameters (`q`, `owners`, `kinds`, `min_*`/`max_*`) and answers
// whole-result facets; the operations OpenBinding already had (versions, seal, fork, evaluate…) stay in
// `core/utils/composition/api.ts` and are re-exported here, as SPHERE's rule "reuse an existing api function" asks.

import { useCallback, useMemo } from 'react';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

export { compositionsApi, languageApi } from '../../core/utils/composition/api';

type Schemas = components['schemas'];

export type CompositionView = Schemas['CompositionView'];
export type PublicCompositionView = Schemas['PublicCompositionView'];
export type CompositionFacets = Schemas['CompositionFacets'];
export type RangeFacet = Schemas['RangeFacet'];
export type VersionFigures = Schemas['VersionFigures'];
export type CompositionGraph = Schemas['CompositionGraph'];

/** One page of a composition list, as every list answers it: the rows, how many match in all, and the facets of them all. */
export interface CompositionPage<T> {
  compositions: T[];
  total: number;
  facets?: CompositionFacets | null;
}

/** The query of a list: the gateway's own parameter names, each a string (as SPHERE's list view hands them over). */
export type ListParams = Record<string, string>;

const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function useCompositionsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** The public compositions of every organization (`GET /v1/compositions`); anybody may list them. */
  const getPublicCompositions = useCallback(
    async (params: ListParams, signal?: AbortSignal) =>
      readResponse<CompositionPage<PublicCompositionView>>(
        await fetchWithInterceptor(`/v1/compositions${query(params)}`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /** The compositions the account reads as a member, across its organizations (`GET /v1/users/me/compositions`). */
  const getMyCompositions = useCallback(
    async (params: ListParams, signal?: AbortSignal) =>
      readResponse<CompositionPage<CompositionView>>(
        await fetchWithInterceptor(`/v1/users/me/compositions${query(params)}`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /** An organization's compositions; a visitor gets its public ones (`GET /v1/organizations/{org}/compositions`). */
  const getOrganizationCompositions = useCallback(
    async (org: string, params: ListParams, signal?: AbortSignal) =>
      readResponse<CompositionPage<CompositionView>>(
        await fetchWithInterceptor(`/v1/organizations/${enc(org)}/compositions${query(params)}`, {
          signal,
        })
      ),
    [fetchWithInterceptor]
  );

  /** Whether the account follows a composition (`GET /v1/composition-follows/{org}/{composition}`). */
  const getFollow = useCallback(
    async (org: string, composition: string, signal?: AbortSignal) =>
      readResponse<Schemas['FollowState']>(
        await fetchWithInterceptor(`/v1/composition-follows/${enc(org)}/${enc(composition)}`, {
          signal,
        })
      ),
    [fetchWithInterceptor]
  );

  /** Follow (`PUT`) or stop following (`DELETE`) a composition. */
  const setFollow = useCallback(
    async (org: string, composition: string, following: boolean) =>
      readResponse<Schemas['FollowState']>(
        await fetchWithInterceptor(`/v1/composition-follows/${enc(org)}/${enc(composition)}`, {
          method: following ? 'PUT' : 'DELETE',
        })
      ),
    [fetchWithInterceptor]
  );

  /** The version graph of a composition and the compositions it was forked from (`GET …/graph`). */
  const getGraph = useCallback(
    async (org: string, composition: string, signal?: AbortSignal) =>
      readResponse<CompositionGraph>(
        await fetchWithInterceptor(
          `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/graph`,
          { signal }
        )
      ),
    [fetchWithInterceptor]
  );

  /** Where a permanent link leads (`GET /v1/permalinks/compositions/{id}?version=`). */
  const resolvePermalink = useCallback(
    async (id: string, version?: string | null, signal?: AbortSignal) =>
      readResponse<Schemas['PermanentLink']>(
        await fetchWithInterceptor(
          `/v1/permalinks/compositions/${enc(id)}${query({ version: version ?? undefined })}`,
          { signal }
        )
      ),
    [fetchWithInterceptor]
  );

  /**
   * The margin per offering plan of a version (`GET …/versions/{version}/margins`), from one of its evaluations (the current
   * one by default) and a number of users (without one, margins come back empty, `users_required`). Members only.
   */
  const getVersionMargins = useCallback(
    async (
      org: string,
      composition: string,
      version: string,
      options: { users?: string; evaluation?: string },
      signal?: AbortSignal
    ) =>
      readResponse<Schemas['CompositionMargins']>(
        await fetchWithInterceptor(
          `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/versions/${enc(version)}/margins${query({ users: options.users, evaluation: options.evaluation })}`,
          { signal }
        )
      ),
    [fetchWithInterceptor]
  );

  /** The composition templates of the catalog (`GET /v1/compositions/templates`); anybody may list them. */
  const listTemplates = useCallback(
    async (signal?: AbortSignal) =>
      readResponse<Schemas['CompositionTemplateList']>(
        await fetchWithInterceptor('/v1/compositions/templates', { signal })
      ),
    [fetchWithInterceptor]
  );

  /** One template with its workflow and binding (`GET /v1/compositions/templates/{template}`). */
  const getTemplate = useCallback(
    async (template: string, signal?: AbortSignal) =>
      readResponse<Schemas['CompositionTemplateView']>(
        await fetchWithInterceptor(`/v1/compositions/templates/${enc(template)}`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /**
   * A composition started from a template (`POST …/compositions/from-template`, MEMBER): its problem is created and its
   * recipes applied, then the composition and its first version are sealed, in one human action.
   */
  const instantiateTemplate = useCallback(
    async (org: string, body: Schemas['CompositionFromTemplate']) =>
      readResponse<Schemas['CompositionInstantiated']>(
        await fetchWithInterceptor(`/v1/organizations/${enc(org)}/compositions/from-template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ),
    [fetchWithInterceptor]
  );

  /** Every version of a composition the account reads, zipped (`GET …/download`). */
  const downloadVersions = useCallback(
    async (org: string, composition: string) => {
      const response = await fetchWithInterceptor(
        `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/download`
      );
      if (!response.ok) await readResponse(response);
      return response.blob();
    },
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({
      getPublicCompositions,
      getMyCompositions,
      getOrganizationCompositions,
      getFollow,
      setFollow,
      getGraph,
      resolvePermalink,
      getVersionMargins,
      listTemplates,
      getTemplate,
      instantiateTemplate,
      downloadVersions,
    }),
    [
      getPublicCompositions,
      getMyCompositions,
      getOrganizationCompositions,
      getFollow,
      setFollow,
      getGraph,
      resolvePermalink,
      getVersionMargins,
      listTemplates,
      getTemplate,
      instantiateTemplate,
      downloadVersions,
    ]
  );
}
