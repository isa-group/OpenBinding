import { lazy } from 'react';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: account. The signed-in person's own profile, plan, keys, identities and notifications: one page, five sections.
// [impl->req~frontend-nav-account-sections~1]

const AccountPage = lazy(() => import('../../pages/Account/AccountPage').then((module) => ({ default: module.AccountPage })));

export const routes: RouteDefinition[] = [
  live('acct-profile', '/app/account/:section?', <AccountPage />),
];

const movedAddresses: MovedRoute[] = [
  moved('acct-key-new', '/app/account/keys/new', '/app/account/keys?create=key', { keepQuery: false }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
