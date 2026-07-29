/**
 * The shapes the accounts endpoints speak in.
 *
 * Kept apart from `client.ts`, which describes solving. The two have nothing to
 * say to each other, and somebody looking for the shape of a solution should
 * not have to scroll past a login form to find it.
 */

export type RoleName = 'user' | 'admin';
export type PlanName = 'FREE' | 'PRO';

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: RoleName;
  is_active: boolean;
  plan: PlanName;
  created_at: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string | null;
}

/** The one response that ever carries the secret. It cannot be fetched again. */
export interface CreatedApiKey extends ApiKeySummary {
  secret: string;
}

export interface LimitUsage {
  limit_id: string;
  limit: number;
  used: number;
  remaining: number;
  unit?: string | null;
  renews_at?: string | null;
}

/** The ceilings that bound one request, rather than a monthly balance. */
export interface PlanCaps {
  max_timeout_s: number;
  max_iterations: number;
  max_payload_mb: number;
  max_binding_space_log10: number;
  job_history_days: number;
}

export interface UsageView {
  plan: PlanName;
  contract_pending: boolean;
  caps: PlanCaps;
  limits: LimitUsage[];
}

export interface AdminUserView extends UserProfile {
  contract_pending: boolean;
  api_key_count: number;
}

export interface AdminUserPage {
  users: AdminUserView[];
  total: number;
  offset: number;
  limit: number;
}

export interface UsageResyncResult {
  plan: PlanName;
  slots_in_flight: number;
  slots_recorded: number;
  corrected_by: number;
}

/**
 * A refusal that is about an allowance rather than a permission.
 *
 * The gateway answers 402 when a plan has nothing left, and 403 when an
 * account may not do something at all. Only the first is worth offering an
 * upgrade for, which is why they are different types here.
 */
export class QuotaError extends Error {
  readonly code: string;
  readonly quota?: {
    limit_id: string;
    limit: number;
    used?: number;
    actual?: number;
    unit?: string;
    renews_at?: string | null;
  };

  constructor(code: string, message: string, quota?: QuotaError['quota']) {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    this.quota = quota;
  }
}

/** The pricing service could not be reached; the account may be perfectly fine. */
export class PricingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingUnavailableError';
  }
}
