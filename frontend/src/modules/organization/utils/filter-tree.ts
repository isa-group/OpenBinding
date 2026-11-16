// The search of SPHERE's organization tree (frontend/src/modules/organization/pages/organizations-list/index.tsx, revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text
// is in THIRD_PARTY_NOTICES.md. Adapted: a match deep in the tree keeps the ancestors that lead to it, pruned to that path.

import type { Organization } from '../api/organizationsApi';

const childrenOf = (org: Organization) => org.children ?? [];

/** The organizations that match `q`, each with the ancestors that lead to a match. */
export function filterTree(orgs: readonly Organization[], q: string): Organization[] {
  const query = q.trim().toLowerCase();
  if (!query) return [...orgs];
  const matches = (org: Organization) =>
    org.name.toLowerCase().includes(query) || org.slug.toLowerCase().includes(query);
  return orgs.flatMap(org => {
    const children = filterTree(childrenOf(org), query);
    return matches(org) || children.length > 0 ? [{ ...org, children }] : [];
  });
}
