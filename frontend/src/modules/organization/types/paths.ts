/** Where an organization's page is: SPHERE's hero with its tabs, at `/orgs/:org/:tab?`. */
export function orgPath(slug: string, tab?: string): string {
  return `/orgs/${encodeURIComponent(slug)}${tab ? `/${tab}` : ''}`;
}
