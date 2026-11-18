// SPHERE's `use<Domain>Api()` shape (frontend/src/modules/pricing/api/pricingsApi.ts, revision 73779a8a,
// https://github.com/SCORELabUS/SPHERE): fetchers over `useAuth().fetchWithInterceptor`, generated types, refusals thrown as
// the typed error `readApiError` reads. The routes are OpenBinding's: the browser never calls SPHERE, the gateway reads it
// (discovery through the organization, snapshots stored by the gateway, preview and apply of an import recipe).

import { useCallback, useMemo } from 'react';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { snapshotYaml } from '../../core/utils/sphere/snapshotYaml';
import { useAuth } from '../../auth/hooks/useAuth';

type Schemas = components['schemas'];

export type SpherePricingSearch = Schemas['SpherePricingSearch'];
export type SpherePricingRow = Schemas['SpherePricingRow'];
export type SphereManifestView = Schemas['SphereManifestView'];
export type SphereVersionEntry = Schemas['SphereVersionEntry'];
export type SphereVersionView = Schemas['SphereVersionView'];
export type SphereImportRecipe = Schemas['SphereImportRecipe'];
export type SphereExpandView = Schemas['SphereExpandView'];
export type SphereCandidate = Schemas['SphereCandidate'];
export type SphereFinding = Schemas['SphereFinding'];
export type SphereSnapshotView = Schemas['SphereSnapshotView'];
export type SphereRecipeView = Schemas['SphereRecipeView'];
export type SphereBase = Schemas['SphereBase'];
export type PricingSnapshotView = Schemas['PricingSnapshotView'];
/** What `sphere/apply` answers: the problem, the revision (new, or the one the package already is) and its compilation. */
export type SphereApplied = Schemas['ProblemUpload'];

/** The query of a SPHERE search, by the gateway's parameter names. */
export interface SphereSearchParams {
  q?: string;
  collection?: string;
  organization?: string;
  registry?: string;
  /** Only pricings whose cheapest plan costs at least this (never an upper bound: SPHERE's own is wrong). */
  minPrice?: number;
  sort?: 'name' | 'minPrice';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const enc = encodeURIComponent;
const root = (org: string) => `/v1/organizations/${enc(org)}`;

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const JSON_BODY = { 'Content-Type': 'application/json' };

/** The SPHERE operations of an organization, over one session. */
export function useSphereApi() {
  const { fetchWithInterceptor } = useAuth();

  const get = useCallback(
    async <T>(path: string, signal?: AbortSignal) =>
      readResponse<T>(await fetchWithInterceptor(path, { signal })),
    [fetchWithInterceptor]
  );
  const post = useCallback(
    async <T>(path: string, body: unknown, signal?: AbortSignal) =>
      readResponse<T>(
        await fetchWithInterceptor(path, {
          method: 'POST',
          headers: JSON_BODY,
          body: JSON.stringify(body),
          signal,
        })
      ),
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({
      /** SPHERE's pricings, searched through the gateway (`GET …/sphere/pricings`), with whole-result facets. */
      searchPricings: (org: string, params: SphereSearchParams, signal?: AbortSignal) =>
        get<SpherePricingSearch>(`${root(org)}/sphere/pricings${query(params)}`, signal),
      /** A family's versions, newest first by date (`GET …/sphere/pricings/{pricingId}`). */
      manifest: (org: string, pricingId: string, registry?: string | null, signal?: AbortSignal) =>
        get<SphereManifestView>(
          `${root(org)}/sphere/pricings/${enc(pricingId)}${query({ registry })}`,
          signal
        ),
      /** One version, snapshotted by the gateway, with its normalised summary (`GET …/versions/{versionId}`). */
      version: (
        org: string,
        pricingId: string,
        versionId: string,
        registry?: string | null,
        signal?: AbortSignal
      ) =>
        get<SphereVersionView>(
          `${root(org)}/sphere/pricings/${enc(pricingId)}/versions/${enc(versionId)}${query({ registry })}`,
          signal
        ),
      /** A stored snapshot's YAML, read once per address. */
      snapshotYaml,
      /** Preview a recipe on a problem (`POST …/problems/{problem}/sphere/expand`); findings come back with a 200. */
      expand: (
        org: string,
        problem: string,
        body: { recipe: SphereImportRecipe; base: SphereBase | null },
        signal?: AbortSignal
      ) =>
        post<SphereExpandView>(`${root(org)}/problems/${enc(problem)}/sphere/expand`, body, signal),
      /** Store what the preview showed (`POST …/sphere/apply`): 201 new, 200 the same revision, 409 when it moved. */
      apply: (
        org: string,
        problem: string,
        body: {
          recipe: SphereImportRecipe;
          base: SphereBase | null;
          name?: string;
          expect: { packageDigest: string };
        }
      ) => post<SphereApplied>(`${root(org)}/problems/${enc(problem)}/sphere/apply`, body),
      /** The pinned recipe of a revision, or of the latest one a SPHERE import generated (`GET …/sphere/recipe`). */
      recipe: (org: string, problem: string, revision?: number, signal?: AbortSignal) =>
        get<SphereRecipeView>(
          `${root(org)}/problems/${enc(problem)}/sphere/recipe${query({ revision })}`,
          signal
        ),
    }),
    [get, post]
  );
}

export type SphereApi = ReturnType<typeof useSphereApi>;
