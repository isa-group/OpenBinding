/**
 * The organization an address names, for the header's New menu and the palette: an organization page (`/orgs/:org`), a
 * resource of an organization (`/compositions/:org/…`, `/problems/:org/…`, `/runs/:org/…`, `/studies/:org/…`), or a creation
 * form's `?org=`. The static children of those addresses (`/orgs/new`, `/orgs/join/:code`, `/runs/new`, …) name none.
 */
const OWNED = new Set(['orgs', 'compositions', 'problems', 'runs', 'studies']);
const STATIC_CHILDREN = new Set(['new', 'join']);

export function organizationOfPath(pathname: string, search = ''): string | undefined {
  const [root, org] = pathname.split('/').filter(Boolean);
  if (root && OWNED.has(root) && org && !STATIC_CHILDREN.has(org)) return decodeURIComponent(org);
  return new URLSearchParams(search).get('org') ?? undefined;
}
