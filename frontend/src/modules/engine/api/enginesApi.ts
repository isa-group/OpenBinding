// Pattern only, after SPHERE frontend/src/modules/api-keys/api/apiKeysApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE has no engines; this is its module API recipe (a `use<Domain>Api()` hook of `useCallback` fetchers over
// `useAuth().fetchWithInterceptor`) for OpenBinding's engine routes: the catalog (a rejected session falls back to the public
// list and says so), the revisions, the account's registrations with their life cycle (activate, deactivate, publication,
// credential, delete) and the engine and registration documents. Refusals throw the typed error `readApiError` reads; every
// identity the gateway answers must carry its four pins.

import { useCallback, useMemo } from 'react';
import type { PlansPricingView, UsageView } from '../../core/api/account';
import type {
  BimProfile,
  CapabilitySelector,
  EngineCatalogEntry,
  EngineCatalogResult,
  EngineManifest,
  EngineMode,
  EngineRegistrationManifest,
  EngineRegistrationReport,
  EngineRegistrationRevision,
  EngineRevision as CreatedEngineRevision,
} from './engineClient';
import type { EngineRevisionDetail as EngineRevision } from './engineRevision';
import { HttpError, readResponse } from '../../core/api/http';
import type { ImmutableResourceRef } from '../../core/api/types';
import { useAuth } from '../../auth/hooks/useAuth';

export type {
  BimProfile,
  CapabilitySelector,
  CreatedEngineRevision,
  EngineCatalogEntry,
  EngineCatalogResult,
  EngineManifest,
  EngineMode,
  EngineRegistrationManifest,
  EngineRegistrationReport,
  EngineRegistrationRevision,
  EngineRevision,
};

/** The pinned BIM v1 binding profile the gateway serves engines against. */
export interface BindingProfilePins {
  id: 'qos-binding/v1';
  output: { apiVersion: 'bim/v1'; kind: 'BindingProblem'; schemaDigest: string };
  protocol: 'bim-engine/v1';
  protocolDigest: string;
  digest: string;
}

const enc = encodeURIComponent;

/** An immutable resource the gateway named without one of its four pins is not trusted. */
function requireExactResourceRef<T extends object>(body: T): T & ImmutableResourceRef {
  for (const field of ['namespace', 'name', 'version', 'digest'] as const) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value !== 'string' || !value)
      throw new Error(`The gateway response omitted the immutable resource pin ${field}.`);
  }
  return body as T & ImmutableResourceRef;
}

/** A registration's address: the name in the path, the other three pins in the query. */
function registrationEndpoint(ref: ImmutableResourceRef, action?: string): string {
  const query = new URLSearchParams({
    namespace: ref.namespace,
    version: ref.version,
    digest: ref.digest,
  });
  return `/v1/engine-registrations/${enc(ref.name)}${action ? `/${action}` : ''}?${query.toString()}`;
}

export function useEnginesApi() {
  const { fetchWithInterceptor } = useAuth();

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> =>
      readResponse<T>(await fetchWithInterceptor(path, init)),
    [fetchWithInterceptor]
  );

  /** The public engine catalogue (`GET /v1/engines`): built-in and published engines. */
  const getPublicEngines = useCallback(
    async () => (await call<{ engines?: EngineCatalogEntry[] }>('/v1/engines')).engines ?? [],
    [call]
  );

  /**
   * The engines this caller may see. A rejected session (401) falls back to the public list but says so, so the catalog
   * can tell the reader that their private engines are hidden.
   */
  const getCatalogEngines = useCallback(async (): Promise<EngineCatalogResult> => {
    try {
      return { engines: await getPublicEngines(), fellBackToPublic: false };
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        return { engines: await getPublicEngines(), fellBackToPublic: true };
      throw error;
    }
  }, [getPublicEngines]);

  /** Every revision the account can see, with its visibility and registration summary. */
  const engineRevisions = useCallback(
    async () =>
      (await call<{ revisions?: EngineRevision[] }>('/v1/engines/revisions')).revisions ?? [],
    [call]
  );

  /** One revision with its document and registration (`GET /v1/engines/{ns}/{name}/revisions/{version}`). */
  const engineRevision = useCallback(
    (namespace: string, name: string, version: string) =>
      call<EngineRevision>(`/v1/engines/${enc(namespace)}/${enc(name)}/revisions/${enc(version)}`),
    [call]
  );

  /** Publish a portable bim/v1 Engine document; a refused one (422 `invalid_engine`) says where. */
  const createEngine = useCallback(
    async (manifest: EngineManifest) =>
      requireExactResourceRef(
        await call<CreatedEngineRevision>('/v1/engines', {
          method: 'POST',
          body: JSON.stringify(manifest),
        })
      ),
    [call]
  );

  /** The installed Profiles with the engine protocol each one targets (`GET /v1/engines/protocol`, anonymous). */
  const getProtocolProfiles = useCallback(
    async () => (await call<{ profiles?: BimProfile[] }>('/v1/engines/protocol')).profiles ?? [],
    [call]
  );

  /** The pins of the BIM v1 binding profile, read again from the gateway. */
  const getBimProfile = useCallback(async (): Promise<BindingProfilePins> => {
    const profile = (await getProtocolProfiles()).find(
      item => (item as { id?: string }).id === 'qos-binding/v1'
    ) as Partial<BindingProfilePins> | undefined;
    const output = profile?.output;
    if (
      !profile ||
      output?.apiVersion !== 'bim/v1' ||
      output?.kind !== 'BindingProblem' ||
      profile.protocol !== 'bim-engine/v1'
    )
      throw new Error('The gateway does not advertise the BIM v1 binding profile.');
    if (
      typeof output.schemaDigest !== 'string' ||
      typeof profile.protocolDigest !== 'string' ||
      typeof profile.digest !== 'string'
    )
      throw new Error('The gateway did not publish complete immutable BIM profile pins.');
    return profile as BindingProfilePins;
  }, [getProtocolProfiles]);

  /** Register private deployment material, apart from the portable Engine. */
  const createEngineRegistration = useCallback(
    async (manifest: EngineRegistrationManifest) =>
      requireExactResourceRef(
        await call<EngineRegistrationRevision>('/v1/engine-registrations', {
          method: 'POST',
          body: JSON.stringify(manifest),
        })
      ),
    [call]
  );

  /** The account's registrations and the ones published for everyone; `review` lists what waits for review (admins). */
  const listEngineRegistrations = useCallback(
    async (options: { review?: boolean } = {}) =>
      (
        (
          await call<{ registrations?: EngineRegistrationRevision[] }>(
            `/v1/engine-registrations${options.review ? '?review=true' : ''}`
          )
        ).registrations ?? []
      ).map(requireExactResourceRef),
    [call]
  );

  const getEngineRegistration = useCallback(
    (ref: ImmutableResourceRef) => call<EngineRegistrationManifest>(registrationEndpoint(ref)),
    [call]
  );

  const getEngineRegistrationReport = useCallback(
    async (ref: ImmutableResourceRef) =>
      requireExactResourceRef(
        await call<EngineRegistrationReport>(registrationEndpoint(ref, 'report'))
      ),
    [call]
  );

  const post = useCallback(
    async (ref: ImmutableResourceRef, action: string) =>
      requireExactResourceRef(
        await call<EngineRegistrationRevision>(registrationEndpoint(ref, action), {
          method: 'POST',
        })
      ),
    [call]
  );

  /** Activation re-runs the conformance check; a failed one answers 409 `conformance_failed` with the report. */
  const activateEngineRegistration = useCallback(
    (ref: ImmutableResourceRef) => post(ref, 'activate'),
    [post]
  );
  const deactivateEngineRegistration = useCallback(
    (ref: ImmutableResourceRef) => post(ref, 'deactivate'),
    [post]
  );
  const requestEngineRegistrationPublication = useCallback(
    (ref: ImmutableResourceRef) => post(ref, 'publication-request'),
    [post]
  );

  const deleteEngineRegistration = useCallback(
    (ref: ImmutableResourceRef) => call<void>(registrationEndpoint(ref), { method: 'DELETE' }),
    [call]
  );

  /** The secret goes in the request only: it is stored encrypted and never returned. */
  const setEngineRegistrationCredential = useCallback(
    async (ref: ImmutableResourceRef, secret: string) =>
      requireExactResourceRef(
        await call<EngineRegistrationRevision>(registrationEndpoint(ref, 'credential'), {
          method: 'PUT',
          body: JSON.stringify({ secret }),
        })
      ),
    [call]
  );

  /** The plan's limits, for the room it leaves for federated engines. */
  const getOwnUsage = useCallback(() => call<UsageView>('/v1/users/me/usage'), [call]);

  /** The published pricing, whose document gives the plan ceilings of an engine's options. */
  const getPlansPricing = useCallback(() => call<PlansPricingView>('/v1/plans/pricing'), [call]);

  return useMemo(
    () => ({
      getPublicEngines,
      getCatalogEngines,
      engineRevisions,
      engineRevision,
      createEngine,
      getProtocolProfiles,
      getBimProfile,
      createEngineRegistration,
      listEngineRegistrations,
      getEngineRegistration,
      getEngineRegistrationReport,
      activateEngineRegistration,
      deactivateEngineRegistration,
      requestEngineRegistrationPublication,
      deleteEngineRegistration,
      setEngineRegistrationCredential,
      getOwnUsage,
      getPlansPricing,
    }),
    [
      getPublicEngines,
      getCatalogEngines,
      engineRevisions,
      engineRevision,
      createEngine,
      getProtocolProfiles,
      getBimProfile,
      createEngineRegistration,
      listEngineRegistrations,
      getEngineRegistration,
      getEngineRegistrationReport,
      activateEngineRegistration,
      deactivateEngineRegistration,
      requestEngineRegistrationPublication,
      deleteEngineRegistration,
      setEngineRegistrationCredential,
      getOwnUsage,
      getPlansPricing,
    ]
  );
}

export type EnginesApi = ReturnType<typeof useEnginesApi>;
