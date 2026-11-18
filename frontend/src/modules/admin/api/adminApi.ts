// Pattern only, after SPHERE frontend/src/modules/pricing/api/pricingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// SPHERE has no administration API; its `use<Domain>Api()` shape is followed: fetchers over `useAuth().fetchWithInterceptor`,
// built once per session, that throw the typed refusal `readApiError` reads. The operations
// of the engine catalogue and of the pricing that administration reads are the existing ones of `api/client.ts`, re-exported
// as SPHERE's rule "reuse an existing api function" asks.

import { useMemo } from 'react';
import type {
  AdminAuditPage,
  AdminModerationOverview,
  AdminOverview,
  AdminQueueStatus,
  AdminSubscriptionView,
  AdminUserPage,
  AdminUserView,
  ContractChangeReason,
  MaintenancePreview,
  RoleName,
  UsageView,
} from '../../core/api/account';
import { readResponse, type Revised } from '../../core/api/http';
import { useAuth } from '../../auth/hooks/useAuth';
import type { AdminErrorListResponse, AdminErrorOverview } from './types';
import { engineClient } from '../../engine/api/engineClient';
import { planClient } from '../../settings/api/planClient';

type Fetch = (path: string, init?: RequestInit) => Promise<Response>;

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** A body and the revision (`ETag`) it came with: the tag a change decided on this reading sends back as `If-Match`. */
async function revised<T>(response: Response): Promise<Revised<T>> {
  const value = await readResponse<T>(response);
  return { value, etag: response.headers.get('ETag') };
}

/** The `If-Match` of a change decided on revision `ifMatch`; with none nothing is sent and the gateway behaves as without one. */
const conditional = (ifMatch: string | null): HeadersInit | undefined =>
  ifMatch ? { 'If-Match': ifMatch } : undefined;

/** The administration operations over one session's `fetchWithInterceptor`. */
export function adminApiOf(fetchWithInterceptor: Fetch) {
  const get = async <T>(path: string) => readResponse<T>(await fetchWithInterceptor(path));
  const send = async <T>(path: string, method: string, body?: unknown, headers?: HeadersInit) =>
    readResponse<T>(
      await fetchWithInterceptor(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    );

  return {
    // -- Accounts ------------------------------------------------------------------------------

    /** One page of the accounts, searched by username or email (`GET /v1/admin/users`). */
    adminListUsers: (params: { search?: string; offset?: number; limit?: number } = {}) =>
      get<AdminUserPage>(
        `/v1/admin/users${query({ search: params.search, offset: params.offset, limit: params.limit })}`
      ),

    /** Activate, deactivate or change the global role of an account (`PATCH /v1/admin/users/{id}`). */
    adminUpdateUser: (userId: string, changes: { is_active?: boolean; role?: RoleName }) =>
      send<AdminUserView>(`/v1/admin/users/${enc(userId)}`, 'PATCH', changes),

    /** The contract of an account, with its revision: the tag a change decided on this reading sends back. */
    adminGetSubscription: async (userId: string) =>
      revised<AdminSubscriptionView>(
        await fetchWithInterceptor(`/v1/admin/users/${enc(userId)}/subscription`)
      ),

    /**
     * An audited agreement. `ifMatch` is the revision of the subscription the change was decided on: a subscription that has moved
     * since is refused with 412 `precondition_failed` and nothing is written. The answer carries the new revision.
     */
    adminUpdateSubscription: async (
      userId: string,
      value: {
        plan: string;
        add_ons: Record<string, number>;
        reason: ContractChangeReason;
        detail?: string;
      },
      ifMatch: string | null
    ) =>
      revised<AdminSubscriptionView>(
        await fetchWithInterceptor(`/v1/admin/users/${enc(userId)}/subscription`, {
          method: 'POST',
          headers: conditional(ifMatch),
          body: JSON.stringify(value),
        })
      ),

    /** A plan change that keeps the add-ons the account already has; `ifMatch` works as in `adminUpdateSubscription`. */
    adminChangePlan: async (userId: string, plan: string, ifMatch: string | null) =>
      revised<AdminUserView>(
        await fetchWithInterceptor(`/v1/admin/users/${enc(userId)}/plan`, {
          method: 'POST',
          headers: conditional(ifMatch),
          body: JSON.stringify({ plan }),
        })
      ),

    /** What the account's plan allows, as its holder sees it. */
    adminGetUserUsage: (userId: string) => get<UsageView>(`/v1/admin/users/${enc(userId)}/usage`),

    /** Take back one key of an account by its id. */
    adminRevokeApiKey: async (userId: string, keyId: string) => {
      await send<void>(`/v1/admin/users/${enc(userId)}/api-keys/${enc(keyId)}`, 'DELETE');
    },

    // -- The platform --------------------------------------------------------------------------

    adminOverview: () => get<AdminOverview>('/v1/admin/overview'),

    /**
     * The platform audit log, newest first: platform events and the events recorded inside an organization. `action` is an exact
     * action name and `organizationId` keeps one organization's events; the gateway's page is 100 events unless `limit` says otherwise.
     */
    adminAudit: (
      filter: { action?: string; organizationId?: string; offset?: number; limit?: number } = {}
    ) =>
      get<AdminAuditPage>(
        `/v1/admin/audit${query({
          action: filter.action,
          organization_id: filter.organizationId,
          offset: filter.offset || undefined,
          limit: filter.limit || undefined,
        })}`
      ),

    adminQueues: () => get<AdminQueueStatus>('/v1/admin/queues'),

    /** How many engines, dialects and engine registrations sit in each publication state. */
    adminModeration: () => get<AdminModerationOverview>('/v1/admin/moderation'),

    adminMaintenancePreview: (retentionDays = 365) =>
      get<MaintenancePreview>(
        `/v1/admin/maintenance/preview${query({ terminal_job_retention_days: retentionDays })}`
      ),

    adminReconcileJobs: () =>
      send<{ settled: number }>('/v1/admin/maintenance/reconcile-jobs', 'POST'),

    /** `errorRetentionDays` is how long error events are kept (1–3650, the gateway defaults to 90); it isn't part of the preview. */
    adminPurgeExpired: (confirmation: string, retentionDays = 365, errorRetentionDays?: number) =>
      send<Record<string, number>>('/v1/admin/maintenance/purge', 'POST', {
        confirmation,
        terminal_job_retention_days: retentionDays,
        ...(errorRetentionDays === undefined ? {} : { error_retention_days: errorRetentionDays }),
      }),

    adminErrorOverview: () => get<AdminErrorOverview>('/v1/admin/errors/overview'),

    adminListErrors: (
      params: {
        category?: string;
        user_id?: string;
        status_code?: number;
        search?: string;
        from_date?: string;
        to_date?: string;
        limit?: number;
        offset?: number;
      } = {}
    ) => get<AdminErrorListResponse>(`/v1/admin/errors${query(params)}`),

    // -- What administration reads from other domains (the existing operations) -----------------

    adminListEngineRegistrations: () => engineClient.adminListEngineRegistrations(),
    adminApproveEngineRegistration: (
      ...args: Parameters<typeof engineClient.adminApproveEngineRegistration>
    ) => engineClient.adminApproveEngineRegistration(...args),
    adminRejectEngineRegistration: (
      ...args: Parameters<typeof engineClient.adminRejectEngineRegistration>
    ) => engineClient.adminRejectEngineRegistration(...args),
    getEngineRegistrationReport: (
      ...args: Parameters<typeof engineClient.getEngineRegistrationReport>
    ) => engineClient.getEngineRegistrationReport(...args),
    getPlansPricing: () => planClient.getPlansPricing(),
    /** A new pricing token for the signed-in account, after an administrator changed their own contract. */
    getPricingToken: () => planClient.getPricingToken(),
  };
}

export type AdminApi = ReturnType<typeof adminApiOf>;

/** The administration API of the signed-in session. */
export function useAdminApi(): AdminApi {
  const { fetchWithInterceptor } = useAuth();
  return useMemo(() => adminApiOf(fetchWithInterceptor), [fetchWithInterceptor]);
}
