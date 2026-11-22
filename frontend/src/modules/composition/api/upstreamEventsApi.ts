// The upstream events API (F6: `…/compositions/{composition}/upstream-events…` and `/v1/users/me/upstream-events`),
// written as environmentsApi.ts writes its own: `useUpstreamEventsApi()` over `useAuth().fetchWithInterceptor` and
// `readResponse`, with the generated types. An event's read answers its `ETag`, which a review sends back as `If-Match`
// (optional: a stale tag is refused with 412, a reviewed event with 409). SPHERE has no upstream events; nothing is copied.

import { useCallback, useMemo } from 'react';
import { readResponse, type Revised } from '../../core/api/http';
import type { MyUpstreamEvent, UpstreamEventDetail, UpstreamEventList } from '../../core/api/types';
import { useAuth } from '../../auth/hooks/useAuth';

const enc = encodeURIComponent;

/** `/v1/organizations/{org}/compositions/{composition}/upstream-events`. */
export const upstreamEventsRoot = (org: string, composition: string) =>
  `/v1/organizations/${enc(org)}/compositions/${enc(composition)}/upstream-events`;

/** What a composition's event list is narrowed to. */
export interface UpstreamEventQuery {
  state?: 'open' | 'reviewed' | 'resolved';
  /** A version id: only the events of that version. */
  version?: string;
  category?: 'no_impact' | 'values_changed' | 'binding_invalid' | 'offering_changed';
  subject?: 'binding' | 'offering';
  limit?: number;
  /** The `nextBefore` of the previous page. */
  before?: string;
}

function query(values: UpstreamEventQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function useUpstreamEventsApi() {
  const { fetchWithInterceptor } = useAuth();

  /** A composition's events, newest first, with the counts and the pricings its live versions read (members only). */
  const list = useCallback(
    async (
      org: string,
      composition: string,
      filter: UpstreamEventQuery = {},
      signal?: AbortSignal
    ) =>
      readResponse<UpstreamEventList>(
        await fetchWithInterceptor(`${upstreamEventsRoot(org, composition)}${query(filter)}`, {
          signal,
        })
      ),
    [fetchWithInterceptor]
  );

  /** One event with its stored diff and its `ETag`. */
  const get = useCallback(
    async (
      org: string,
      composition: string,
      event: string,
      signal?: AbortSignal
    ): Promise<Revised<UpstreamEventDetail>> => {
      const response = await fetchWithInterceptor(
        `${upstreamEventsRoot(org, composition)}/${enc(event)}`,
        { signal }
      );
      const value = await readResponse<UpstreamEventDetail>(response);
      return { value, etag: response.headers.get('ETag') };
    },
    [fetchWithInterceptor]
  );

  /** Marks an open event reviewed with an optional note (MEMBER); `etag` is the read's, when there is one. */
  const review = useCallback(
    async (
      org: string,
      composition: string,
      event: string,
      note: string,
      etag: string | null
    ): Promise<Revised<UpstreamEventDetail>> => {
      const response = await fetchWithInterceptor(
        `${upstreamEventsRoot(org, composition)}/${enc(event)}/review`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
          body: JSON.stringify({ note }),
        }
      );
      const value = await readResponse<UpstreamEventDetail>(response);
      return { value, etag: response.headers.get('ETag') };
    },
    [fetchWithInterceptor]
  );

  /** The open upstream events of every organization the account belongs to (the dashboard's panel). */
  const mine = useCallback(
    async (limit = 10, signal?: AbortSignal) =>
      (
        await readResponse<{ events: MyUpstreamEvent[] }>(
          await fetchWithInterceptor(`/v1/users/me/upstream-events?limit=${limit}`, { signal })
        )
      ).events,
    [fetchWithInterceptor]
  );

  return useMemo(() => ({ list, get, review, mine }), [list, get, review, mine]);
}
