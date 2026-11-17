// Adapted from SPHERE frontend/src/modules/presentation/layouts/router/header-routes.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's menus in SPHERE's order (Tools before Explore), pointing at the screens OpenBinding has today; each
// later block of the convergence repoints its entries (the editors, the explore pages, the about pages). The New menu and the
// user menu live here too, so the header, the mobile drawer and the public header share one list.

import { newStudyPath } from '../../../../routes/paths/studies';

export interface HeaderRoute {
  name: string;
  disabled: boolean;
  to?: string;
  /** Marks the entry active for these address prefixes too (the composition showcase under /c/, say). */
  match?: string[];
  children?: HeaderRoute[];
}

export const headerRoutes: HeaderRoute[] = [
  {
    name: 'Tools',
    disabled: false,
    children: [
      { name: 'Composition editor', disabled: false, to: '/editor' },
      { name: 'Composition2Yaml', disabled: false, to: '/language' },
      { name: 'Problem editor', disabled: false, to: '/problem-editor' },
    ],
  },
  {
    name: 'Explore',
    disabled: false,
    children: [
      { name: 'Organizations', disabled: false, to: '/organizations' },
      { name: 'Compositions', disabled: false, to: '/compositions', match: ['/p/'] },
      { name: 'Engines', disabled: false, to: '/engines' },
    ],
  },
  { name: 'Pricing', disabled: false, to: '/pricing' },
  { name: 'About', disabled: false, to: '/about' },
];

export interface MenuEntry {
  label: string;
  to: string;
}

/** What "New" creates. Resources of an organization are created in the organization the header has in hand. */
export function newEntries(organization: string | undefined): MenuEntry[] {
  const inOrganization: MenuEntry[] = organization
    ? [
        { label: 'Composition', to: `/compositions/new?org=${encodeURIComponent(organization)}` },
        { label: 'Problem', to: `/problem-editor?org=${encodeURIComponent(organization)}` },
        { label: 'Run', to: `/runs/new?org=${encodeURIComponent(organization)}` },
        { label: 'Study', to: newStudyPath(organization) },
      ]
    : [];
  return [
    ...inOrganization,
    { label: 'Organization', to: '/orgs/new' },
    { label: 'Engine', to: '/me/engines/new' },
  ];
}

/** The signed-in person's own places (SPHERE's user menu): Administration only for platform administrators. */
export function userEntries(isAdmin: boolean): MenuEntry[] {
  return [
    { label: 'Organizations', to: '/me/orgs' },
    { label: 'Compositions', to: '/me/compositions' },
    { label: 'Inbox', to: '/notifications' },
    { label: 'Engines', to: '/me/engines' },
    { label: 'API keys', to: '/me/api-keys' },
    { label: 'Settings', to: '/me/settings' },
    ...(isAdmin ? [{ label: 'Administration', to: '/app/admin' }] : []),
  ];
}

const under = (pathname: string, root: string) =>
  root === '/'
    ? pathname === '/'
    : pathname === root || pathname.startsWith(`${root}/`) || pathname.startsWith(`${root}?`);

/** Whether an entry (or one of its children) is the page on show. */
export function isActive(route: HeaderRoute, pathname: string): boolean {
  if (route.to && under(pathname, route.to.split('?')[0])) return true;
  if (route.match?.some(prefix => pathname.startsWith(prefix))) return true;
  return route.children?.some(child => isActive(child, pathname)) ?? false;
}
