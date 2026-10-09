import { lazy } from 'react';
import { live } from './define';
import type { RouteDefinition } from './types';

// D2 · Pricing & account (7 screens)

const Pricing = lazy(() => import('../pages/Pricing/Pricing').then((module) => ({ default: module.Pricing })));
const Account = lazy(() => import('../pages/Account/Account').then((module) => ({ default: module.Account })));
const AccountUsage = lazy(() => import('../pages/Account/AccountUsage').then((module) => ({ default: module.AccountUsage })));
const AccountKeys = lazy(() => import('../pages/Account/AccountKeys').then((module) => ({ default: module.AccountKeys })));
const AccountKeyNew = lazy(() => import('../pages/Account/AccountKeyNew').then((module) => ({ default: module.AccountKeyNew })));
const AccountIdentities = lazy(() => import('../pages/Account/AccountServices').then((module) => ({ default: module.AccountIdentities })));
const AccountNotifications = lazy(() => import('../pages/Account/AccountNotifications').then((module) => ({ default: module.AccountNotifications })));

export const d2Routes: RouteDefinition[] = [
  live('pub-pricing', '/pricing', <Pricing />),
  live('acct-profile', '/app/account', <Account />),
  live('acct-usage', '/app/account/usage', <AccountUsage />),
  live('acct-keys', '/app/account/keys', <AccountKeys />),
  live('acct-key-new', '/app/account/keys/new', <AccountKeyNew />),
  live('acct-identities', '/app/account/identities', <AccountIdentities />),
  live('acct-notifications', '/app/account/notifications', <AccountNotifications />),
];
