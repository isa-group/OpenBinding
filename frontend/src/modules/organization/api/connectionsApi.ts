// SPHERE's `use<Domain>Api()` shape (frontend/src/modules/pricing/api/pricingsApi.ts, revision 73779a8a,
// https://github.com/SCORELabUS/SPHERE): fetchers over `useAuth().fetchWithInterceptor`, generated types, refusals thrown as
// the typed error `readApiError` reads. An organization's connections (`/v1/organizations/{org}/connections`), ADMIN only:
// the key is written and never read back.

import { useCallback, useMemo } from 'react';
import { errorFromResponse, readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

type Schemas = components['schemas'];

export type ConnectionView = Schemas['ConnectionView'];
export type ConnectionScope = Schemas['ConnectionScope'];

const root = (org: string) => `/v1/organizations/${encodeURIComponent(org)}/connections`;

export function useConnectionsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** The organization's connections, each with its key's last four characters and never the key. */
  const list = useCallback(
    async (org: string, signal?: AbortSignal) =>
      (
        await readResponse<Schemas['ConnectionList']>(
          await fetchWithInterceptor(root(org), { signal })
        )
      ).connections,
    [fetchWithInterceptor]
  );

  /**
   * Connect (or replace) the organization's SPHERE key: SPHERE validates it first. `ifMatch` is the revision a replace read
   * (412 when the connection changed since); the answer carries the new revision.
   */
  const putSphere = useCallback(
    async (org: string, apiKey: string, ifMatch: string | null) => {
      const response = await fetchWithInterceptor(`${root(org)}/sphere`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(ifMatch ? { 'If-Match': ifMatch } : {}),
        },
        body: JSON.stringify({ apiKey }),
      });
      if (!response.ok) throw await errorFromResponse(response);
      return {
        connection: (await response.json()) as ConnectionView,
        etag: response.headers.get('ETag'),
      };
    },
    [fetchWithInterceptor]
  );

  /** Remove the organization's SPHERE connection and its key. */
  const removeSphere = useCallback(
    async (org: string) =>
      readResponse<void>(await fetchWithInterceptor(`${root(org)}/sphere`, { method: 'DELETE' })),
    [fetchWithInterceptor]
  );

  return useMemo(() => ({ list, putSphere, removeSphere }), [list, putSphere, removeSphere]);
}
