import type {
  AdminAuditPage, AdminModerationOverview, AdminOverview, AdminQueueStatus, AdminSubscriptionView, AdminUserPage, AdminUserView, LimitUsage, UsageView,
} from '../../api/auth';
import type { Organization, PricingControlRoom } from '../../api/platform';
import type { AdminErrorListResponse, AdminErrorOverview, ApiErrorEventItem } from '../../pages/Admin/types';

/** Stand-ins for the answers of /v1/admin/*, for the tests of the administration screens. They name no real person. */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const account = (n: number, username: string, role: 'user' | 'admin', plan: string, extra: Partial<AdminUserView> = {}): AdminUserView => ({
  id: id(n),
  username,
  email: `${username.replace('.', '-')}@example.invalid`,
  role,
  is_active: true,
  plan,
  created_at: '2026-03-02T00:00:00Z',
  cas_verified: false,
  contract_pending: false,
  api_key_count: 1,
  ...extra,
});

export const ALEX = account(5, 'alex.rivera', 'admin', 'PRO', { created_at: '2026-01-10T00:00:00Z' });
export const MARIA = account(1, 'maria.santos', 'user', 'RESEARCH', { api_key_count: 2, cas_verified: true });
export const SAM = account(2, 'sam.okafor', 'user', 'BASIC', { created_at: '2026-06-15T00:00:00Z' });
export const JORDAN = account(3, 'jordan.lee', 'user', 'BASIC', { contract_pending: true, api_key_count: 0, created_at: '2026-07-01T00:00:00Z' });
export const PRIYA = account(4, 'priya.nair', 'user', 'ADVANCED', { api_key_count: 3, created_at: '2026-04-20T00:00:00Z' });
export const DANA = account(7, 'dana.kim', 'user', 'BASIC', { is_active: false, api_key_count: 0, created_at: '2026-02-02T00:00:00Z' });

export const USERS: AdminUserView[] = [MARIA, SAM, JORDAN, PRIYA, ALEX, DANA];

export function userPage(users: AdminUserView[] = USERS, extra: Partial<AdminUserPage> = {}): AdminUserPage {
  return { users, total: users.length, offset: 0, limit: 50, ...extra };
}

export function subscriptionOf(user: AdminUserView, addOns: Record<string, number> = {}, pricingVersion = '0.1.0'): AdminSubscriptionView {
  return {
    user,
    subscription: { plan: user.plan, add_ons: addOns, pricing_version: pricingVersion, renews_at: '2026-11-01T00:00:00Z' },
    changed: false,
  };
}

const limit = (limitId: string, max: number, used: number, unit: string | null = null): LimitUsage => ({
  limit_id: limitId, limit: max, used, remaining: Math.max(0, max - used), unit, renews_at: '2026-11-01T00:00:00Z',
});

export function usageOf(plan: string, taskStarts = 18, concurrent = 1): UsageView {
  return {
    plan,
    contract_pending: false,
    features: { solve: true, advancedAnalytics: plan !== 'BASIC', reproducibilityArchive: false },
    capabilities: {},
    limits: {
      taskStarts: limit('taskStarts', plan === 'BASIC' ? 10 : 50, taskStarts, 'solve/month'),
      solverSeconds: limit('solverSeconds', plan === 'BASIC' ? 900 : 30000, plan === 'BASIC' ? 610 : 7420, 'second/month'),
      concurrentJobs: limit('concurrentJobs', plan === 'BASIC' ? 1 : 3, concurrent, 'job'),
      maxTimeoutSeconds: limit('maxTimeoutSeconds', plan === 'BASIC' ? 60 : 900, 0, 'second'),
      organizations: limit('organizations', plan === 'BASIC' ? 1 : 5, 0, 'organization'),
      members: limit('members', plan === 'BASIC' ? 2 : 15, 0, 'member'),
      projects: limit('projects', plan === 'BASIC' ? 3 : 50, 0, 'project'),
      privateProjects: limit('privateProjects', plan === 'BASIC' ? 1 : 30, 0, 'project'),
      collections: limit('collections', plan === 'BASIC' ? 2 : 50, 0, 'collection'),
      studies: limit('studies', plan === 'BASIC' ? 1 : 25, 0, 'study'),
      storageBytes: limit('storageBytes', plan === 'BASIC' ? 104857600 : 5368709120, 0, 'byte'),
    },
  };
}

/** The platform audit log: a contract change, the LIVE release and a reconciliation. */
export const AUDIT: AdminAuditPage = {
  events: [
    {
      id: id(403), organizationId: null, actorId: ALEX.id, action: 'maintenance.jobs.reconciled', targetType: 'JobQueue', targetId: null,
      detail: { settled: 2 }, createdAt: '2026-10-08T09:00:00Z',
    },
    {
      id: id(402), organizationId: null, actorId: ALEX.id, action: 'pricing.live.activated', targetType: 'PricingRelease', targetId: id(900),
      detail: { version: '0.1.0' }, createdAt: '2026-09-02T09:00:00Z',
    },
    {
      id: id(401), organizationId: null, actorId: ALEX.id, action: 'contract.subscription.changed', targetType: 'User', targetId: MARIA.id,
      detail: {
        reason: 'institutional_agreement', detail: 'Agreement 2026-14', pricingVersion: '0.1.0',
        previous: { plan: 'BASIC', addOns: {} }, current: { plan: 'RESEARCH', addOns: {} },
      },
      createdAt: '2026-09-01T09:00:00Z',
    },
  ],
  total: 3,
  offset: 0,
  limit: 100,
};

/** Jobs: one waiting, one running far beyond its budget. `now` is when the answer is read. */
export function queuesAt(now: number): AdminQueueStatus {
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  return {
    counts: { queued: 1, running: 1, completed: 2, failed: 1, cancelled: 1 },
    oldestInFlight: [
      { id: id(701), ownerId: MARIA.id, engine: 'minizinc', state: 'running', createdAt: ago(26 * 3600), budgetSeconds: 300 },
      { id: id(702), ownerId: SAM.id, engine: 'random-search', state: 'queued', createdAt: ago(30), budgetSeconds: 60 },
    ],
  };
}

export const EMPTY_QUEUES: AdminQueueStatus = {
  counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
  oldestInFlight: [],
};

/** The platform in numbers: seven accounts across four plans, and one contract change on record. */
export const OVERVIEW: AdminOverview = {
  counts: { users: 7, apiKeys: 9, identities: 3, organizations: 3, projects: 5, cases: 4, studies: 2, studyRuns: 3, artifacts: 12 },
  jobs: { queued: 1, running: 1, completed: 2, failed: 1, cancelled: 1 },
  contracts: { BASIC: 3, ADVANCED: 1, RESEARCH: 1, PRO: 2 },
  recentAudit: [
    { id: id(403), action: 'maintenance.jobs.reconciled', targetType: 'JobQueue', targetId: null, actorId: ALEX.id, createdAt: '2026-10-08T09:00:00Z' },
    { id: id(401), action: 'contract.subscription.changed', targetType: 'User', targetId: MARIA.id, actorId: ALEX.id, createdAt: '2026-09-01T09:00:00Z' },
  ],
};

/** SPHERE answers, SPACE does not; one private draft waits next to the LIVE release. */
export const CONTROL_ROOM = {
  identity: { organization: 'OpenBinding', slug: 'openbinding' },
  sphere: { enabled: true, reachable: true },
  space: { enabled: true, reachable: false },
  live: '0.1.0',
  releases: [
    { version: '0.2.0', sphere_state: 'PRIVATE_DRAFT', is_live: false },
    { version: '0.1.0', sphere_state: 'PUBLIC_RELEASE', is_live: true },
  ],
  remoteVersions: [],
  spaceVersions: { active: [], archived: [] },
  divergence: { onlyInSphere: [], onlyLocal: [] },
} as unknown as PricingControlRoom;

export const MODERATION: AdminModerationOverview = {
  engines: { published: 3, pending_review: 0 },
  dialects: { published: 2, pending_review: 1 },
  registrations: { private: 2, pending_review: 1 },
};

/** An engine registration its owner submitted for publication. */
export const PENDING_ENGINE = {
  namespace: 'maria-santos', name: 'edge-solver', version: '0.3.1', digest: `sha256-${'e5f6'.repeat(16)}`, status: 'pending_review' as const, active: true,
};

const hour = (offset: number) => new Date(Date.UTC(2026, 9, 9, 12 - offset)).toISOString();

export const ERROR_OVERVIEW: AdminErrorOverview = {
  total_errors_24h: 9,
  by_category_24h: { pricing_quota: 5, concurrency: 2, system_bug: 1, validation: 1 },
  by_status_code_24h: { '402': 5, '429': 2, '503': 1, '422': 1 },
  top_users_quota: [{ userId: SAM.id, email: SAM.email, errorCount: 7, lastSeen: '2026-10-09T07:40:00Z' }],
  top_solvers_failed: [{ engine: '/v1/engines/minizinc/solve', failureCount: 2, lastSeen: '2026-10-08T18:20:00Z' }],
  timeline: [3, 2, 1, 0].map((n) => ({
    timestamp: hour(n), quota: n, concurrency: n > 1 ? 1 : 0, solver: 0, system: n === 0 ? 1 : 0, validation: 0,
  })),
};

const event = (n: number, statusCode: number, category: ApiErrorEventItem['category'], code: string, endpoint: string, user: AdminUserView | null, at: string, detail: ApiErrorEventItem['detail'] = {}): ApiErrorEventItem => ({
  id: id(800 + n),
  user_id: user?.id ?? null,
  userId: user?.id ?? null,
  user_email: user?.email ?? null,
  userEmail: user?.email ?? null,
  organization_id: null,
  organizationId: null,
  status_code: statusCode,
  statusCode,
  category,
  error_code: code,
  errorCode: code,
  endpoint,
  http_method: 'POST',
  httpMethod: 'POST',
  detail,
  created_at: at,
  createdAt: at,
});

export const ERROR_EVENTS: ApiErrorEventItem[] = [
  event(1, 402, 'pricing_quota', 'quota_exceeded', '/v1/jobs', SAM, '2026-10-09T07:40:00Z', {
    quota: { limit_id: 'taskStarts', used: 10, limit: 10, unit: 'solve/month', renews_at: '2026-11-01T00:00:00Z' },
  }),
  event(2, 402, 'pricing_quota', 'quota_exceeded', '/v1/jobs', SAM, '2026-10-09T06:10:00Z'),
  event(3, 429, 'concurrency', 'concurrency_limit_exceeded', '/v1/jobs', SAM, '2026-10-08T18:20:00Z'),
  event(4, 503, 'system_bug', 'pricing_unavailable', '/v1/users/me/usage', null, '2026-10-08T03:10:00Z'),
];

export const ERRORS: AdminErrorListResponse = { items: ERROR_EVENTS, total: ERROR_EVENTS.length, limit: 50, offset: 0 };

/** An organization the signed-in administrator belongs to, with one below it. */
export const ORG: Organization = {
  id: id(950), slug: 'isa-demo', name: 'ISA Demo Group', parent_id: null, billing_sponsor_user_id: MARIA.id, effective_role: 'OWNER', created_at: '2026-03-03T00:00:00Z',
};
export const SUB_ORG: Organization = {
  id: id(951), slug: 'qos-lab', name: 'QoS Lab (sub-organization)', parent_id: ORG.id, billing_sponsor_user_id: MARIA.id, effective_role: 'OWNER', created_at: '2026-03-04T00:00:00Z',
};
