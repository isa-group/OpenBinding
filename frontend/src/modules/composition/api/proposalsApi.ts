// The proposals API (F6: `POST|GET …/compositions/{composition}/proposals`, `GET|DELETE /v1/organizations/{org}/proposals/
// {proposal}`, `POST …/proposals/{proposal}/confirm` and `GET /v1/users/me/proposals`), written as environmentsApi.ts
// writes its own: `useProposalsApi()` over `useAuth().fetchWithInterceptor` and `readResponse`, with the generated types.
// A proposal is read, confirmed and cancelled at the organization level, so one made without a composition (F7) uses the
// same calls. Confirmation answers the final proposal as JSON (D-h); a refusal is the typed error `readApiError` reads.

import { useCallback, useMemo } from 'react';
import { readResponse } from '../../core/api/http';
import type { ProposalCreate, ProposalView } from '../../core/api/types';
import { useAuth } from '../../auth/hooks/useAuth';

const enc = encodeURIComponent;

/** `/v1/organizations/{org}/compositions/{composition}/proposals`. */
export const compositionProposalsRoot = (org: string, composition: string) =>
  `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/proposals`;

/** `/v1/organizations/{org}/proposals/{proposal}`. */
export const proposalRoot = (org: string, proposal: string) =>
  `/v1/organizations/${enc(org)}/proposals/${enc(proposal)}`;

const JSON_BODY = { 'Content-Type': 'application/json' };

export function useProposalsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** Proposes a change to a composition (MEMBER): it is stored pending, with each step's base and preview. */
  const create = useCallback(
    async (org: string, composition: string, body: ProposalCreate) =>
      readResponse<ProposalView>(
        await fetchWithInterceptor(compositionProposalsRoot(org, composition), {
          method: 'POST',
          headers: JSON_BODY,
          body: JSON.stringify(body),
        })
      ),
    [fetchWithInterceptor]
  );

  /** One proposal, with each seal step's document and its diff against the version in effect. */
  const get = useCallback(
    async (org: string, proposal: string, signal?: AbortSignal) =>
      readResponse<ProposalView>(
        await fetchWithInterceptor(proposalRoot(org, proposal), { signal })
      ),
    [fetchWithInterceptor]
  );

  /** A composition's proposals, newest first (every member reads them; lists carry no preview). */
  const list = useCallback(
    async (
      org: string,
      composition: string,
      options: { status?: ProposalView['status']; limit?: number } = {},
      signal?: AbortSignal
    ) => {
      const query = new URLSearchParams();
      if (options.status) query.set('status', options.status);
      query.set('limit', String(options.limit ?? 20));
      return (
        await readResponse<{ proposals: ProposalView[] }>(
          await fetchWithInterceptor(`${compositionProposalsRoot(org, composition)}?${query}`, {
            signal,
          })
        )
      ).proposals;
    },
    [fetchWithInterceptor]
  );

  /** Confirms a proposal (its author only): the final proposal, step by step, or the refusal. */
  const confirm = useCallback(
    async (org: string, proposal: string, confirmation?: string) =>
      readResponse<ProposalView>(
        await fetchWithInterceptor(`${proposalRoot(org, proposal)}/confirm`, {
          method: 'POST',
          headers: JSON_BODY,
          body: JSON.stringify(confirmation === undefined ? {} : { confirmation }),
        })
      ),
    [fetchWithInterceptor]
  );

  /** Cancels a pending proposal (its author only). */
  const cancel = useCallback(
    async (org: string, proposal: string) =>
      readResponse<ProposalView>(
        await fetchWithInterceptor(proposalRoot(org, proposal), { method: 'DELETE' })
      ),
    [fetchWithInterceptor]
  );

  /** The caller's own proposals across its organizations, pending by default (the dashboard's panel). */
  const mine = useCallback(
    async (limit = 10, signal?: AbortSignal) =>
      (
        await readResponse<{ proposals: ProposalView[] }>(
          await fetchWithInterceptor(`/v1/users/me/proposals?status=pending&limit=${limit}`, {
            signal,
          })
        )
      ).proposals,
    [fetchWithInterceptor]
  );

  return useMemo(
    () => ({ create, get, list, confirm, cancel, mine }),
    [create, get, list, confirm, cancel, mine]
  );
}
