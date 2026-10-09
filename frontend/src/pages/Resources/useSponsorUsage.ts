import type { UsageView } from '../../api/auth';
import { apiClient } from '../../api/client';
import type { Organization } from '../../api/platform';
import { useAuth } from '../../contexts/auth';
import { useResource } from '../../utils/useResource';

export interface SponsorUsage {
  /** The signed-in account pays for this organization, so the sponsored allowances in its usage are the organization’s own. */
  isSponsor: boolean;
  /** The account’s own usage: its per-request ceilings and, for a sponsor, the sponsored allowances. `null` while read, and when it can’t be. */
  usage: UsageView | null;
  loading: boolean;
  plan: string | undefined;
}

/** What `GET /v1/users/me/usage` says, and whether the account is the sponsor of the organization. */
export function useSponsorUsage(organization: Organization): SponsorUsage {
  const { user } = useAuth();
  const usage = useResource<UsageView | null>(`resources-usage:${user?.id ?? ''}`, () => apiClient.getOwnUsage().catch(() => null));
  return {
    isSponsor: Boolean(user) && organization.billing_sponsor_user_id === user?.id,
    usage: usage.data ?? null,
    loading: usage.status === 'loading',
    plan: user?.plan,
  };
}
