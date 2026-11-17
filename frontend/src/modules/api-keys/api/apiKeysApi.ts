// Adapted from SPHERE frontend/src/modules/api-keys/api/apiKeysApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a `useApiKeysApi()` hook over `fetchWithInterceptor` instead of functions taking a token; OpenBinding's
// `/v1/users/me/api-keys` routes and generated types (permissions, a boundary, engine access, rotation instead of SPHERE's
// revoke-then-delete); refusals throw the typed error `readApiError` reads.

import { useCallback, useMemo } from 'react';
import type { EngineCatalogEntry } from '../../../api/client';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

type Schemas = components['schemas'];

export type ApiKeySummary = Schemas['ApiKeySummary'];
export type CreateApiKeyRequest = Schemas['CreateApiKeyRequest'];
export type CreatedApiKey = Schemas['CreatedApiKey'];
export type ApiKeyBoundary = Schemas['ApiKeyBoundary'];
export type ApiKeyEngineAccess = Schemas['ApiKeyEngineAccess'];
export type ApiKeyEngineRef = Schemas['ApiKeyEngineRef'];
export type ApiKeyPermission = Schemas['ApiKeyPermission'];
export type UsageView = Schemas['UsageView'];
export type { EngineCatalogEntry };

const BASE = '/v1/users/me/api-keys';

export function useApiKeysApi() {
  const { fetchWithInterceptor } = useAuth();

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> =>
      readResponse<T>(await fetchWithInterceptor(path, init)),
    [fetchWithInterceptor]
  );

  const listApiKeys = useCallback(
    async () => (await call<Schemas['ApiKeyList']>(BASE)).api_keys,
    [call]
  );

  /** The answer carries the secret. It is the only one that ever will. */
  const createApiKey = useCallback(
    (payload: CreateApiKeyRequest) =>
      call<CreatedApiKey>(BASE, { method: 'POST', body: JSON.stringify(payload) }),
    [call]
  );

  const revokeApiKey = useCallback(
    (id: string) => call<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    [call]
  );

  /** A new secret for the same key; the old one stops working at once. */
  const rotateApiKey = useCallback(
    (id: string) =>
      call<CreatedApiKey>(`${BASE}/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),
    [call]
  );

  /** The plan's limits, for the number of keys it allows. */
  const getUsage = useCallback(() => call<UsageView>('/v1/users/me/usage'), [call]);

  /** The engines this account can see, to narrow a key to exact revisions. */
  const listEngines = useCallback(
    async () => (await call<{ engines?: EngineCatalogEntry[] }>('/v1/engines')).engines ?? [],
    [call]
  );

  return useMemo(
    () => ({ listApiKeys, createApiKey, revokeApiKey, rotateApiKey, getUsage, listEngines }),
    [listApiKeys, createApiKey, revokeApiKey, rotateApiKey, getUsage, listEngines]
  );
}
