import { lazy } from 'react';
import { Account } from '../pages/Account/Account';
import { live, pending } from './define';
import type { RouteDefinition } from './types';

// D2 · Pricing & account (7 screens)

const Pricing = lazy(() => import('../pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));

export const d2Routes: RouteDefinition[] = [
  live('pub-pricing', '/pricing', <Pricing />),
  live('acct-profile', '/app/account', <Account />),
  pending('acct-usage', '/app/account/usage'),
  pending('acct-keys', '/app/account/keys'),
  pending('acct-key-new', '/app/account/keys/new'),
  pending('acct-identities', '/app/account/identities'),
  pending('acct-notifications', '/app/account/notifications'),
];
