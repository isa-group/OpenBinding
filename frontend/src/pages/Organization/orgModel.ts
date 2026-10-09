import type { Organization, OrganizationRole } from '../../api/platform';

/** Roles from the most to the least powerful, as the selects list them. */
export const ROLES: readonly OrganizationRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];

const RANK: Record<OrganizationRole, number> = { VIEWER: 1, MEMBER: 2, ADMIN: 3, OWNER: 4 };

export function rankOf(role: OrganizationRole | null | undefined): number {
  return role ? RANK[role] : 0;
}

/** Does `role` reach `minimum`? A missing role reaches nothing. */
export function atLeast(role: OrganizationRole | null | undefined, minimum: OrganizationRole): boolean {
  return rankOf(role) >= RANK[minimum];
}

export function higherRole(a: OrganizationRole | null | undefined, b: OrganizationRole | null | undefined): OrganizationRole | null {
  return rankOf(a) >= rankOf(b) ? a ?? null : b ?? null;
}

/** What each role can do, in the words the invitation dialog and the tooltips use. */
export const ROLE_SUMMARY: Record<OrganizationRole, string> = {
  VIEWER: 'can look',
  MEMBER: 'can create and edit',
  ADMIN: 'can manage members and settings',
  OWNER: 'everything, including sponsor',
};

/** Slugs the gateway accepts (`OrganizationCreate.slug`). */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** `Distributed Systems Lab` → `distributed-systems-lab`: what the address suggests while the name is typed. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** Two letters for the tile of an organization: the initials of its first two words, or its first two letters. */
export function initialsOf(name: string): string {
  const words = name.replace(/\([^)]*\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return (words[0] ?? name).slice(0, 2).toUpperCase() || '··';
}

const TILE_COLOURS = ['var(--tp-primary-deep)', 'var(--tp-primary)', 'var(--tp-sunshine-800)'] as const;

/** A stable brand colour per organization, so the same one looks the same on every screen. */
export function tileColour(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILE_COLOURS[hash % TILE_COLOURS.length];
}

export function byName(a: Organization, b: Organization): number {
  return a.name.localeCompare(b.name);
}

/** The chain of visible ancestors, nearest parent first. An ancestor you cannot see ends the chain. */
export function ancestorsOf(organization: Organization, all: readonly Organization[]): Organization[] {
  const chain: Organization[] = [];
  let parentId = organization.parent_id;
  while (parentId) {
    const parent = all.find((item) => item.id === parentId);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    parentId = parent.parent_id;
  }
  return chain;
}

/** Every visible organization below `organization`, at any depth. */
export function descendantsOf(organization: Organization, all: readonly Organization[]): Organization[] {
  const found: Organization[] = [];
  const visit = (parentId: string) => {
    for (const child of all.filter((item) => item.parent_id === parentId)) {
      if (found.includes(child)) continue;
      found.push(child);
      visit(child.id);
    }
  };
  visit(organization.id);
  return found;
}

export interface TreeNode {
  organization: Organization;
  depth: number;
  children: TreeNode[];
}

/** The visible organizations as a forest: an organization whose parent you cannot see starts its own tree. */
export function buildForest(all: readonly Organization[]): TreeNode[] {
  const ids = new Set(all.map((item) => item.id));
  const build = (organization: Organization, depth: number): TreeNode => ({
    organization,
    depth,
    children: all.filter((item) => item.parent_id === organization.id).sort(byName).map((child) => build(child, depth + 1)),
  });
  return all.filter((item) => !item.parent_id || !ids.has(item.parent_id)).sort(byName).map((root) => build(root, 0));
}

export function flatten(forest: readonly TreeNode[]): TreeNode[] {
  return forest.flatMap((node) => [node, ...flatten(node.children)]);
}

export interface RoleSource {
  kind: 'own' | 'inherited';
  /** The organization the role comes from, when it is inherited. */
  from?: Organization;
  /** The sentence for a tooltip or a caption. */
  text: string;
}

/**
 * Where the role of the signed-in person in `organization` comes from. The API reports only the effective role:
 * when a visible ancestor already grants at least that much, the role is read as inherited; otherwise the person
 * must hold it directly (the effective role is the highest of the two).
 */
export function roleSource(organization: Organization, all: readonly Organization[]): RoleSource {
  const role = organization.effective_role;
  const explaining = ancestorsOf(organization, all).find((ancestor) => rankOf(ancestor.effective_role) >= rankOf(role) && rankOf(role) > 0);
  if (explaining) return { kind: 'inherited', from: explaining, text: `Inherited from ${explaining.name}` };
  const parent = ancestorsOf(organization, all)[0];
  if (parent && rankOf(parent.effective_role) > 0) {
    return { kind: 'own', text: `Your own role here (higher than ${parent.effective_role} inherited from ${parent.name})` };
  }
  return { kind: 'own', text: 'Your own role' };
}

interface Person {
  user_id: string;
  username: string | null;
  email: string | null;
}

/** A person by the name the accounts know them by: username, then email; `fallback` when no list names them. */
export function personName(userId: string | null | undefined, people: readonly Person[], me: { id: string; username: string } | null, fallback = 'Not recorded'): string {
  if (!userId) return fallback;
  if (me && me.id === userId) return me.username;
  const found = people.find((item) => item.user_id === userId);
  return found?.username ?? found?.email ?? fallback;
}

/** The sponsor of an organization. The API names only the account id, so the name comes from whoever is listed. */
export function sponsorName(organization: Organization, people: readonly Person[], me: { id: string; username: string } | null): string {
  const name = personName(organization.billing_sponsor_user_id, people, me, '');
  if (!name) return 'Another account';
  return me && me.id === organization.billing_sponsor_user_id ? `${name} (you)` : name;
}

/** Where `organization` sits: the visible ancestors from the top, then itself. */
export function pathOf(organization: Organization, all: readonly Organization[]): Organization[] {
  return [...ancestorsOf(organization, all).reverse(), organization];
}
