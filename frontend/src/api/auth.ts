/**
 * The shapes the accounts endpoints speak in.
 *
 * Kept apart from `client.ts`, which describes solving. The two have nothing to
 * say to each other, and somebody looking for the shape of a solution should
 * not have to scroll past a login form to find it.
 */

export type RoleName = 'user' | 'admin';
export type ApiKeyPermission =
  | 'account:read'
  | 'account:write'
  | 'keys:read'
  | 'keys:write'
  | 'instances:read'
  | 'instances:write'
  | 'instances:validate'
  | 'jobs:read'
  | 'engines:read'
  | 'engines:execute'
  | 'engines:register'
  | 'engines:publish'
  | 'engines:moderate'
  | 'extensions:register'
  | 'extensions:moderate'
  | 'organizations:read'
  | 'organizations:write'
  | 'projects:read'
  | 'projects:write'
  | 'studies:read'
  | 'studies:write'
  | 'reports:read'
  | 'reports:write'
  | 'artifacts:read'
  | 'artifacts:write'
  | 'notifications:read'
  | 'pricing:read'
  | 'pricing:admin'
  | 'admin:accounts:read'
  | 'admin:accounts:write';

export interface ApiKeyEngineRef {
  namespace: string;
  name: string;
  version: string;
  digest: string;
}

export interface ApiKeyEngineAccess {
  all: boolean;
  engines: ApiKeyEngineRef[];
}

export interface CreateApiKeyRequest {
  name: string;
  permissions: ApiKeyPermission[];
  engine_access: ApiKeyEngineAccess;
  boundary?: {
    methods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>;
    organizations?: string[];
    projects?: string[];
    resource_kinds?: string[];
    slugs?: string[];
  };
  expires_at?: string | null;
}

export interface UserProfile {
  id: string;
  username: string;
  email: string;
  role: RoleName;
  is_active: boolean;
  plan: string;
  created_at: string;
  /** Added by the collaborative platform; optional keeps older API fixtures compatible. */
  cas_verified?: boolean;
  institutional_branding?: boolean;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** A plan the gateway changed as a side effect of signing in: linking CAS raises BASIC to RESEARCH at no extra cost. */
export interface PlanChange {
  from: string;
  to: string;
  extra_cost: boolean;
}

/** `POST /v1/auth/cas/exchange`: the session, and the plan change linking CAS caused, if any (`null` otherwise). */
export interface CasSession extends TokenPair {
  plan_changed?: PlanChange | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  permissions: ApiKeyPermission[];
  engine_access: ApiKeyEngineAccess;
  boundary?: CreateApiKeyRequest['boundary'];
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

export interface UsageView {
  plan: string;
  contract_pending: boolean;
  features: Record<string, boolean>;
  capabilities: Record<string, number | null>;
  limits: Record<string, LimitUsage>;
}

/**
 * The active Pricing2Yaml document exactly as `GET /v1/pricing/catalog` serves it, as JSON.
 * Infinite limits (`.inf` in the YAML) arrive as `null`: the gateway has no legal JSON for them.
 */
export type PricingCatalog = Record<string, unknown>;

/** `GET /v1/pricing/current`: which public release is live, and the fingerprint of its content. */
export interface PricingCurrentView {
  version: string;
  digest: string;
  url: string;
}

/** What a `contract.changed` notification carries in its payload (admin routes, `_apply_subscription`). */
export interface ContractChangePayload {
  reason?: string | null;
  detail?: string | null;
  previous?: { plan?: string; addOns?: Record<string, number> };
  current?: { plan?: string; addOns?: Record<string, number> };
  pricingVersion?: string;
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

export type ContractChangeReason =
  | 'new_feature'
  | 'administrative_decision'
  | 'institutional_agreement'
  | 'retirement_or_discount';

export interface AdminSubscriptionView {
  user: AdminUserView;
  subscription: {
    plan: string;
    add_ons: Record<string, number>;
    pricing_version: string;
    renews_at: string | null;
  };
  changed: boolean;
}

export interface ExternalIdentity {
  id: string;
  provider: 'us-cas' | string;
  subject: string;
  verifiedAt: string;
}

export interface Notification {
  id: string;
  kind: string;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  inbox: boolean;
  email_contract_changes: boolean;
  email_invitations: boolean;
  email_job_failures: boolean;
}

export interface AdminOverview {
  counts: Record<string, number>;
  jobs: Record<string, number>;
  contracts: Record<string, number>;
  recentAudit: Array<{
    id: string;
    action: string;
    targetType: string;
    targetId: string | null;
    actorId: string | null;
    createdAt: string;
  }>;
}

export interface AdminAuditPage {
  events: Array<{
    id: string;
    /** Set for the events recorded inside an organization; `null` for platform events. */
    organizationId: string | null;
    /** The address of that organization, when the gateway sends it. */
    organizationSlug?: string | null;
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    detail: Record<string, unknown>;
    createdAt: string;
  }>;
  total: number;
  offset: number;
  limit: number;
}

/** What `POST /v1/admin/organizations/{id}/sponsor` answers: the organization, now with its new sponsor. */
export interface AdminSponsorTransferResult {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  billing_sponsor_user_id: string;
  effective_role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' | null;
  created_at: string;
}

export type SponsorProposalStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

/**
 * A request that somebody become the billing sponsor of an organization (`SponsorProposalView`). Nobody can make another person
 * pay: naming them creates this, and the sponsor changes only when they accept. Every status but `pending` is final.
 */
export interface SponsorProposal {
  id: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  proposed_user_id: string | null;
  proposed_username: string | null;
  proposed_by_user_id: string | null;
  proposed_by_username: string | null;
  status: SponsorProposalStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  /** Why the system closed it (`expired`, `replaced`, `sponsor_changed`, `user_deactivated`…). */
  decision_reason: string | null;
}

/** The answer to naming a sponsor is a proposal (202) when somebody else was named, and the organization (200) when the caller named themselves. */
export function isSponsorProposal(value: unknown): value is SponsorProposal {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return typeof body.id === 'string' && typeof body.status === 'string' && typeof body.expires_at === 'string' && typeof body.organization_slug === 'string';
}

/**
 * `GET /v1/admin/moderation`: how many revisions sit in each publication state, per kind. The contract only says
 * “an object”; the gateway answers `{ engines, dialects, registrations }`, each a map of status → count.
 */
export interface AdminModerationOverview {
  engines: Record<string, number>;
  dialects: Record<string, number>;
  registrations: Record<string, number>;
}

export interface AdminQueueStatus {
  counts: Record<string, number>;
  oldestInFlight: Array<{
    id: string;
    ownerId: string | null;
    engine: string;
    state: string;
    createdAt: string;
    budgetSeconds: number;
  }>;
}

export interface MaintenancePreview {
  expiredArtifacts: number;
  expiredApiKeys: number;
  terminalJobs: number;
  abandonedJobs: number;
  terminalJobCutoff: string;
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
