// Pattern only, after SPHERE frontend/src/modules/pricing/api/pricingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's problem routes and generated types; refusals throw the typed error `readApiError` reads; the list is
// named by the gateway's parameters (`q`, `origin`, `composition`, `limit`, `offset`) and each row embeds its latest revision
// and how many revisions it has; a change names the revision it was read at (`If-Match`). The operations OpenBinding already
// had (uploads, revisions, the source, the compilation, its IR) stay in `api/problems.ts` and are re-exported here, as
// SPHERE's rule "reuse an existing api function" asks.

import { useCallback, useMemo } from 'react';
import { readResponse, type Revised } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

export { problemsApi } from './problemsClient';
export type {
  CompilationIr,
  Problem,
  ProblemCompilation,
  ProblemRevision,
  ProblemRevisionDetail,
  ProblemUpload,
} from './problemsClient';

type Schemas = components['schemas'];

/** A problem as the gateway lists and reads it: its latest revision and how many revisions it has. */
export type ProblemView = Schemas['ProblemView'];
export type RevisionView = Schemas['RevisionView'];

/** One page of an organization's problems: the rows and how many match in all. */
export interface ProblemPage {
  problems: ProblemView[];
  total: number;
  limit: number;
  offset: number;
}

const enc = encodeURIComponent;
const root = (org: string) => `/v1/organizations/${enc(org)}/problems`;

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined && value !== '') search.set(name, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function useProblemsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** An organization's problems (`GET /v1/organizations/{org}/problems`): VIEWER and above. */
  const getOrganizationProblems = useCallback(
    async (org: string, params: Record<string, string | undefined>, signal?: AbortSignal) =>
      readResponse<ProblemPage>(
        await fetchWithInterceptor(`${root(org)}${query(params)}`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /** One problem, with the revision a later change names (`ETag`). */
  const getProblem = useCallback(
    async (org: string, problem: string, signal?: AbortSignal): Promise<Revised<ProblemView>> => {
      const response = await fetchWithInterceptor(`${root(org)}/${enc(problem)}`, { signal });
      const value = await readResponse<ProblemView>(response);
      return { value, etag: response.headers.get('ETag') };
    },
    [fetchWithInterceptor]
  );

  /** The revisions of a problem, newest first. */
  const getRevisions = useCallback(
    async (org: string, problem: string, signal?: AbortSignal) =>
      readResponse<RevisionView[]>(
        await fetchWithInterceptor(`${root(org)}/${enc(problem)}/revisions`, { signal })
      ),
    [fetchWithInterceptor]
  );

  /** Rename a problem or change its description (MEMBER), at the revision it was read (`If-Match`; 412 when it changed). */
  const updateProblem = useCallback(
    async (
      org: string,
      problem: string,
      body: Schemas['ProblemUpdate'],
      ifMatch: string | null
    ): Promise<Revised<ProblemView>> => {
      const response = await fetchWithInterceptor(`${root(org)}/${enc(problem)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(ifMatch ? { 'If-Match': ifMatch } : {}),
        },
        body: JSON.stringify(body),
      });
      const value = await readResponse<ProblemView>(response);
      return { value, etag: response.headers.get('ETag') };
    },
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({ getOrganizationProblems, getProblem, getRevisions, updateProblem }),
    [getOrganizationProblems, getProblem, getRevisions, updateProblem]
  );
}
