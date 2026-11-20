// The composition environments API (`/v1/organizations/{org}/compositions/{composition}/environments/…`), written the way
// compositionsApi.ts writes SPHERE's module APIs: `useEnvironmentsApi()` over `useAuth().fetchWithInterceptor` and
// `readResponse`, with the generated types. SPHERE has no environments; nothing here is copied.
// A read of one environment and every write that changes it answer the environment's `ETag`, which the next write sends back
// as `If-Match` (an adoption requires it). The feed itself is read by applications with an environment key; a member's
// download here is the same bytes.

import { useCallback, useMemo } from 'react';
import { readResponse, type Revised } from '../../core/api/http';
import type {
  CompositionAdoptionList,
  CompositionEnvironmentCreate,
  CompositionEnvironmentUpdate,
  CompositionEnvironmentView,
  EnvironmentAdoptResult,
  EnvironmentCheck,
  FeedKeyCreated,
} from '../../core/api/types';
import { useAuth } from '../../auth/hooks/useAuth';

const enc = encodeURIComponent;

/** `/v1/organizations/{org}/compositions/{composition}/environments`. */
export const environmentsRoot = (org: string, composition: string) =>
  `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/environments`;

/** `…/environments/{environment}`. */
export const environmentRoot = (org: string, composition: string, environment: string) =>
  `${environmentsRoot(org, composition)}/${enc(environment)}`;

const JSON_BODY = { 'Content-Type': 'application/json' };

async function revised<T>(response: Response): Promise<Revised<T>> {
  const value = await readResponse<T>(response);
  return { value, etag: response.headers.get('ETag') };
}

export function useEnvironmentsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** A composition's environments, by slug (members only). */
  const listEnvironments = useCallback(
    async (org: string, composition: string, signal?: AbortSignal) =>
      (
        await readResponse<{ environments: CompositionEnvironmentView[] }>(
          await fetchWithInterceptor(environmentsRoot(org, composition), { signal })
        )
      ).environments,
    [fetchWithInterceptor]
  );

  /** One environment with its `ETag`. */
  const getEnvironment = useCallback(
    async (org: string, composition: string, environment: string, signal?: AbortSignal) =>
      revised<CompositionEnvironmentView>(
        await fetchWithInterceptor(environmentRoot(org, composition, environment), { signal })
      ),
    [fetchWithInterceptor]
  );

  /** A new environment (ADMIN). */
  const createEnvironment = useCallback(
    async (org: string, composition: string, body: CompositionEnvironmentCreate) =>
      revised<CompositionEnvironmentView>(
        await fetchWithInterceptor(environmentsRoot(org, composition), {
          method: 'POST',
          headers: JSON_BODY,
          body: JSON.stringify(body),
        })
      ),
    [fetchWithInterceptor]
  );

  /** A change of an environment (ADMIN), refused with 412 when it changed after `etag` was read. */
  const updateEnvironment = useCallback(
    async (
      org: string,
      composition: string,
      environment: string,
      body: CompositionEnvironmentUpdate,
      etag: string | null
    ) =>
      revised<CompositionEnvironmentView>(
        await fetchWithInterceptor(environmentRoot(org, composition, environment), {
          method: 'PATCH',
          headers: { ...JSON_BODY, ...(etag ? { 'If-Match': etag } : {}) },
          body: JSON.stringify(body),
        })
      ),
    [fetchWithInterceptor]
  );

  /** Deletes an environment with its keys and history (ADMIN); its feed stops answering. */
  const deleteEnvironment = useCallback(
    async (org: string, composition: string, environment: string, etag: string | null) => {
      const response = await fetchWithInterceptor(environmentRoot(org, composition, environment), {
        method: 'DELETE',
        headers: etag ? { 'If-Match': etag } : undefined,
      });
      if (!response.ok) await readResponse(response);
    },
    [fetchWithInterceptor]
  );

  /** Adopts a version (an id, a label or an ordinal) in an environment; `etag` is the environment's, and it is required. */
  const adopt = useCallback(
    async (
      org: string,
      composition: string,
      environment: string,
      body: { version: string; note: string },
      etag: string
    ) =>
      revised<EnvironmentAdoptResult>(
        await fetchWithInterceptor(`${environmentRoot(org, composition, environment)}/adopt`, {
          method: 'POST',
          headers: { ...JSON_BODY, 'If-Match': etag },
          body: JSON.stringify(body),
        })
      ),
    [fetchWithInterceptor]
  );

  /** An environment's adoptions, newest first; `before` an ordinal for the next page. */
  const listAdoptions = useCallback(
    async (
      org: string,
      composition: string,
      environment: string,
      options: { limit?: number; before?: number } = {},
      signal?: AbortSignal
    ) => {
      const search = new URLSearchParams();
      if (options.limit) search.set('limit', String(options.limit));
      if (options.before) search.set('before', String(options.before));
      const query = search.toString();
      return readResponse<CompositionAdoptionList>(
        await fetchWithInterceptor(
          `${environmentRoot(org, composition, environment)}/adoptions${query ? `?${query}` : ''}`,
          { signal }
        )
      );
    },
    [fetchWithInterceptor]
  );

  /** A new feed key (ADMIN): the only answer that carries its secret. */
  const createFeedKey = useCallback(
    async (org: string, composition: string, environment: string, label: string) =>
      readResponse<FeedKeyCreated>(
        await fetchWithInterceptor(`${environmentRoot(org, composition, environment)}/keys`, {
          method: 'POST',
          headers: JSON_BODY,
          body: JSON.stringify({ label }),
        })
      ),
    [fetchWithInterceptor]
  );

  /** Revokes a feed key (ADMIN); it stops working on the next request. */
  const revokeFeedKey = useCallback(
    async (org: string, composition: string, environment: string, key: string) => {
      const response = await fetchWithInterceptor(
        `${environmentRoot(org, composition, environment)}/keys/${enc(key)}`,
        { method: 'DELETE' }
      );
      if (!response.ok) await readResponse(response);
    },
    [fetchWithInterceptor]
  );

  /** Checks the version in effect against its sources now (MEMBER); nothing is written. */
  const checkEnvironment = useCallback(
    async (org: string, composition: string, environment: string) =>
      readResponse<EnvironmentCheck>(
        await fetchWithInterceptor(`${environmentRoot(org, composition, environment)}/check`, {
          method: 'POST',
        })
      ),
    [fetchWithInterceptor]
  );

  /** The composition in effect, as the feed serves it (a member's session reads it too). */
  const downloadInEffect = useCallback(
    async (org: string, composition: string, environment: string) => {
      const response = await fetchWithInterceptor(
        `${environmentRoot(org, composition, environment)}/composition`
      );
      if (!response.ok) await readResponse(response);
      return response.text();
    },
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({
      listEnvironments,
      getEnvironment,
      createEnvironment,
      updateEnvironment,
      deleteEnvironment,
      adopt,
      listAdoptions,
      createFeedKey,
      revokeFeedKey,
      checkEnvironment,
      downloadInEffect,
    }),
    [
      listEnvironments,
      getEnvironment,
      createEnvironment,
      updateEnvironment,
      deleteEnvironment,
      adopt,
      listAdoptions,
      createFeedKey,
      revokeFeedKey,
      checkEnvironment,
      downloadInEffect,
    ]
  );
}
