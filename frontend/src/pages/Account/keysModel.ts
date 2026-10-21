import type { ApiKeyEngineAccess, ApiKeyPermission, ApiKeySummary, CreateApiKeyRequest } from '../../api/auth';
import { shortDigest } from '../../utils/digest';

/**
 * What an API key can be given. The permission set is closed (`ApiKeyPermission`): every one appears exactly
 * once below, so a permission added to the API without a place here fails the type check in `PERMISSION_GROUPS`.
 */

export interface PermissionOption {
  id: ApiKeyPermission;
  description: string;
}

export interface PermissionGroup {
  name: string;
  permissions: PermissionOption[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    name: 'Account',
    permissions: [
      { id: 'account:read', description: 'Read your profile and usage' },
      { id: 'account:write', description: 'Change your profile' },
      { id: 'keys:read', description: 'List your API keys' },
      { id: 'keys:write', description: 'Create, rotate and revoke keys' },
    ],
  },
  {
    name: 'Instances',
    permissions: [
      { id: 'instances:read', description: 'Read snapshots and verify' },
      { id: 'instances:write', description: 'Create snapshots, generator' },
      { id: 'instances:validate', description: 'Validate packages' },
    ],
  },
  {
    name: 'Execution',
    permissions: [
      { id: 'jobs:read', description: 'Read jobs and results' },
      { id: 'engines:read', description: 'List engines' },
      { id: 'engines:execute', description: 'Launch, cancel and retry jobs' },
      { id: 'engines:register', description: 'Register engine revisions' },
      { id: 'engines:publish', description: 'Request engine publication' },
      { id: 'engines:moderate', description: 'Review engine publications' },
    ],
  },
  {
    name: 'Extensions',
    permissions: [
      { id: 'extensions:register', description: 'Submit dialects and resources' },
      { id: 'extensions:moderate', description: 'Approve dialects and resources' },
    ],
  },
  {
    name: 'Collaboration',
    permissions: [
      { id: 'organizations:read', description: 'Read organizations' },
      { id: 'organizations:write', description: 'Change organizations and members' },
      { id: 'projects:read', description: 'Read projects, cases, jobs' },
      { id: 'projects:write', description: 'Change projects and cases' },
      { id: 'studies:read', description: 'Read studies and runs' },
      { id: 'studies:write', description: 'Change and run studies' },
      { id: 'reports:read', description: 'Read reports' },
      { id: 'reports:write', description: 'Edit and publish reports' },
      { id: 'artifacts:read', description: 'Read library artifacts' },
      { id: 'artifacts:write', description: 'Edit library artifacts' },
    ],
  },
  {
    name: 'Other',
    permissions: [
      { id: 'notifications:read', description: 'Read notifications' },
      { id: 'pricing:read', description: 'Read pricing' },
      { id: 'pricing:admin', description: 'Administer pricing' },
      { id: 'admin:accounts:read', description: 'Read all accounts' },
      { id: 'admin:accounts:write', description: 'Change accounts' },
    ],
  },
];

// Exhaustive by construction: a Record over the closed permission set.
const CATALOGUED: Record<ApiKeyPermission, true> = {
  'account:read': true, 'account:write': true, 'keys:read': true, 'keys:write': true,
  'instances:read': true, 'instances:write': true, 'instances:validate': true,
  'jobs:read': true, 'engines:read': true, 'engines:execute': true, 'engines:register': true, 'engines:publish': true, 'engines:moderate': true,
  'extensions:register': true, 'extensions:moderate': true,
  'organizations:read': true, 'organizations:write': true, 'projects:read': true, 'projects:write': true,
  'studies:read': true, 'studies:write': true, 'reports:read': true, 'reports:write': true, 'artifacts:read': true, 'artifacts:write': true,
  'notifications:read': true, 'pricing:read': true, 'pricing:admin': true, 'admin:accounts:read': true, 'admin:accounts:write': true,
};

export const ALL_PERMISSIONS = Object.keys(CATALOGUED) as ApiKeyPermission[];

/** Only a global administrator may grant these; the API answers 403 `permission_not_grantable` to anybody else. */
export const ADMIN_ONLY: ReadonlySet<ApiKeyPermission> = new Set<ApiKeyPermission>([
  'engines:moderate', 'extensions:moderate', 'pricing:admin', 'admin:accounts:read', 'admin:accounts:write',
]);

/** These need all Engines or at least one exact revision (the API's `ENGINE_LIMITED_PERMISSIONS`). */
export const ENGINE_LIMITED: ReadonlySet<ApiKeyPermission> = new Set<ApiKeyPermission>([
  'engines:read', 'engines:execute', 'engines:register', 'engines:publish', 'engines:moderate',
  'instances:validate', 'jobs:read', 'studies:read', 'studies:write',
]);

export const PRESETS: Record<'read' | 'run', ApiKeyPermission[]> = {
  read: ['jobs:read', 'studies:read', 'reports:read', 'projects:read'],
  run: ['engines:read', 'engines:execute', 'jobs:read', 'instances:validate'],
};

export const EXPIRY_PRESETS = [
  { id: '30', label: 'In 30 days', days: 30 },
  { id: '90', label: 'In 90 days', days: 90 },
  { id: '365', label: 'In 1 year', days: 365 },
  { id: 'never', label: 'Never', days: null },
] as const;

export type ExpiryId = (typeof EXPIRY_PRESETS)[number]['id'];

/** The instant a preset ends, counted from `now` (ms). `null` for a key that never expires. */
export function expiryFor(id: ExpiryId, now: number): string | null {
  const preset = EXPIRY_PRESETS.find((item) => item.id === id);
  return preset?.days ? new Date(now + preset.days * 86_400_000).toISOString() : null;
}

export function describeDescription(permission: ApiKeyPermission): string {
  for (const group of PERMISSION_GROUPS) {
    const found = group.permissions.find((item) => item.id === permission);
    if (found) return found.description;
  }
  return permission;
}

export function needsEngines(permissions: Iterable<ApiKeyPermission>): boolean {
  for (const permission of permissions) if (ENGINE_LIMITED.has(permission)) return true;
  return false;
}

export function describeEngineAccess(access: ApiKeyEngineAccess): string {
  if (access.all) return 'All engines, including future ones';
  if (access.engines.length === 0) return 'No engines';
  return `Only ${access.engines.map((engine) => `${engine.namespace}/${engine.name}@${engine.version} (${shortDigest(engine.digest)})`).join(', ')}`;
}

type Boundary = NonNullable<CreateApiKeyRequest['boundary']>;

/** One short label per restriction: `GET only`, `org isa-demo`, `jobs, studies`. Empty when there is none. */
export function boundaryLabels(boundary: ApiKeySummary['boundary'] | undefined): string[] {
  const value: Partial<Record<keyof Boundary, readonly string[] | null | undefined>> = boundary ?? {};
  const labels: string[] = [];
  if (value.methods?.length) labels.push(`${value.methods.join(', ')} only`);
  if (value.organizations?.length) labels.push(...value.organizations.map((slug) => `org ${slug}`));
  if (value.projects?.length) labels.push(...value.projects.map((slug) => `project ${slug}`));
  if (value.resource_kinds?.length) labels.push(value.resource_kinds.join(', '));
  if (value.slugs?.length) labels.push(...value.slugs.map((slug) => `slug ${slug}`));
  return labels;
}
