import { lazy } from 'react';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: account. The signed-in person's own profile, plan, keys, identities and notifications: one page, five sections.

const AccountPage = lazy(() =>
  import('../../pages/Account/AccountPage').then(module => ({ default: module.AccountPage }))
);

export const routes: RouteDefinition[] = [
  live('acct-profile', '/app/account/:section?', <AccountPage />),
];
