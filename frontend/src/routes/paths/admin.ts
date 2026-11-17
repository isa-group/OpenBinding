// Address builders of administration (design §4.2 item 26): the sections of `/admin/:section?` and the page of one account,
// `/admin/users/:user`, whose tab is `?tab=`. Code that links into administration builds the address here.

/** The sections of `/admin`, in the order of its nav. Overview has no segment of its own. */
export const ADMIN_SECTION_IDS = [
  'overview',
  'users',
  'moderation',
  'audit',
  'errors',
  'queues',
  'maintenance',
] as const;

export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];

/** The address of a section: `/admin` for the overview, `/admin/<section>` otherwise. */
export const adminPath = (section: AdminSectionId = 'overview'): string =>
  section === 'overview' ? '/admin' : `/admin/${section}`;

/** The section an address segment names; no segment is the overview, and an unknown one is no section at all. */
export function adminSectionOf(segment: string | undefined): AdminSectionId | null {
  if (segment === undefined || segment === '') return 'overview';
  if (segment === 'overview') return null;
  return ADMIN_SECTION_IDS.find(section => section === segment) ?? null;
}

/** The tabs of an account's page, in order; Identity is the page's own address. */
export const ADMIN_USER_TABS = ['identity', 'keys', 'agreement', 'usage'] as const;

export type AdminUserTab = (typeof ADMIN_USER_TABS)[number];

/** The tab a `?tab=` value names; a missing or unknown one is Identity. */
export const adminUserTabOf = (value: string | null): AdminUserTab =>
  ADMIN_USER_TABS.find(tab => tab === value) ?? 'identity';

/** One account's page: `/admin/users/<id>`, with `?tab=` for every tab but Identity. */
export const adminUserPath = (user: string, tab: AdminUserTab = 'identity'): string =>
  `/admin/users/${encodeURIComponent(user)}${tab === 'identity' ? '' : `?tab=${tab}`}`;
