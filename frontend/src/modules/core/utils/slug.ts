// The address of a new item of an organization (a problem, a study, a composition, an organization): what the gateway accepts as a
// slug, and the one a name suggests while it is typed.

/** Slugs the gateway accepts (`OrganizationCreate.slug`, `CompositionCreate.slug`, …). */
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
