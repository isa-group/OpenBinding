/**
 * Where an organization's page is. The organization page moves to SPHERE's hero at `/orgs/:org/:tab?` in B2; until then the
 * workspace overview serves it.
 */
export function orgPath(slug: string): string {
  return `/app/${encodeURIComponent(slug)}`;
}
