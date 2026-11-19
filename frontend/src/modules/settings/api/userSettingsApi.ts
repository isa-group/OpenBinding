// Adapted from SPHERE frontend/src/modules/settings/api/userSettingsApi.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's gateway routes and generated types (`PATCH /v1/users/me` for the email and the password,
// notification preferences per kind × channel, beta features, the plan); refusals throw the typed error
// `readApiError` reads; the revisions (`ETag`) come back so a write can send `If-Match`. SPHERE's profile, social links,
// avatar and Google identity calls are not ported.

import { useCallback, useMemo } from 'react';
import type { PlansPricingView, UsageView, UserProfile } from '../../core/api/account';
import { readResponse } from '../../core/api/http';
import type { components } from '../../core/api/openapi';
import { useAuth } from '../../auth/hooks/useAuth';

type Schemas = components['schemas'];

export type UpdateProfileRequest = Schemas['UpdateProfileRequest'];
export type NotificationPreferences = Schemas['NotificationPreferences'];
export type KindChannels = Schemas['KindChannels'];
export type BetaFeatures = Schemas['BetaFeatures'];
export type { UsageView };

/** An answer with the revision it was read at, to send back as `If-Match`. */
export interface Revised<T> {
  value: T;
  etag: string | null;
}

const ME = '/v1/users/me';

export function useUserSettingsApi() {
  const { fetchWithInterceptor } = useAuth();

  const call = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> =>
      readResponse<T>(await fetchWithInterceptor(path, init)),
    [fetchWithInterceptor]
  );

  const revised = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<Revised<T>> => {
      const response = await fetchWithInterceptor(path, init);
      const value = await readResponse<T>(response);
      return { value, etag: response.headers.get('ETag') };
    },
    [fetchWithInterceptor]
  );

  /** Change the sign-in email or the password: both need the current password. */
  const updateProfile = useCallback(
    (changes: UpdateProfileRequest) =>
      call<UserProfile>(ME, { method: 'PATCH', body: JSON.stringify(changes) }),
    [call]
  );

  /** Delete the account: `confirmation` is the username, typed. */
  const deleteAccount = useCallback(
    (confirmation: string, currentPassword?: string) =>
      call<void>(ME, {
        method: 'DELETE',
        body: JSON.stringify({ confirmation, current_password: currentPassword || null }),
      }),
    [call]
  );

  const getNotificationPreferences = useCallback(
    () => revised<NotificationPreferences>('/v1/notifications/preferences'),
    [revised]
  );

  const updateNotificationPreferences = useCallback(
    (value: NotificationPreferences, ifMatch: string | null) =>
      revised<NotificationPreferences>('/v1/notifications/preferences', {
        method: 'PUT',
        body: JSON.stringify(value),
        ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}),
      }),
    [revised]
  );

  const getBetaFeatures = useCallback(
    () => revised<BetaFeatures>(`${ME}/settings/beta-features`),
    [revised]
  );

  const updateBetaFeatures = useCallback(
    (enabled: boolean, ifMatch: string | null) =>
      revised<BetaFeatures>(`${ME}/settings/beta-features`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
        ...(ifMatch ? { headers: { 'If-Match': ifMatch } } : {}),
      }),
    [revised]
  );

  /** The plan, its features and its functional limits. */
  const getUsage = useCallback(() => call<UsageView>(`${ME}/usage`), [call]);

  /** The published pricing: its version label, the YAML and the document the plan section words. */
  const getPlansPricing = useCallback(() => call<PlansPricingView>('/v1/plans/pricing'), [call]);

  return useMemo(
    () => ({
      updateProfile,
      deleteAccount,
      getNotificationPreferences,
      updateNotificationPreferences,
      getBetaFeatures,
      updateBetaFeatures,
      getUsage,
      getPlansPricing,
    }),
    [
      updateProfile,
      deleteAccount,
      getNotificationPreferences,
      updateNotificationPreferences,
      getBetaFeatures,
      updateBetaFeatures,
      getUsage,
      getPlansPricing,
    ]
  );
}
