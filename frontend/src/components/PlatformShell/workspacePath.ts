/**
 * First segments after /app that an organization slug may not take: the fixed places of the application and the sections
 * under an organization, so `/app/:org` never claims `/app/engines/new`, `/app/account` and friends. The gateway refuses
 * the same slugs (422 `slug_reserved`, `RESERVED_ORGANIZATION_SLUGS` in `models/platform.py`); keep the two lists equal.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin', 'account', 'engines', 'organizations', 'invitations',
  'compositions', 'presets', 'runs', 'problems', 'studies', 'settings', 'problem-editor', 'new',
  'join', 'public',
]);

export interface WorkspaceSlugs {
  org?: string;
}

/** The organization slug named by the URL, when it names one. */
export function workspaceSlugs(pathname: string): WorkspaceSlugs {
  const [root, org] = pathname.split('/').filter(Boolean);
  if (root !== 'app' || !org || RESERVED_SLUGS.has(org)) return {};
  return { org };
}
