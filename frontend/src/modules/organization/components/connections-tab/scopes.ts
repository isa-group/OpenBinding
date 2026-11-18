import type { ConnectionScope } from '../../api/connectionsApi';

/** The key's scopes in words: `MANAGEMENT on 2 organizations`, `VIEW on 1 organization and ALL on 1 organization`. */
export function scopesText(scopes: ConnectionScope[] | null | undefined): string {
  if (!scopes) return 'SPHERE did not say which organizations the key may act in';
  if (scopes.length === 0) return 'No SPHERE organization';
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope.scope, (counts.get(scope.scope) ?? 0) + 1);
  return [...counts]
    .map(
      ([scope, count]) => `${scope} on ${count} ${count === 1 ? 'organization' : 'organizations'}`
    )
    .join(' and ');
}
