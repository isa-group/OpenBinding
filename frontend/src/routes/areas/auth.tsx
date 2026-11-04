import { lazy } from 'react';
import { CasCallback } from '../../pages/Auth/CasCallback';
import { Login } from '../../pages/Auth/Login';
import { PasswordResetPage } from '../../pages/Auth/PasswordReset';
import { Register } from '../../pages/Auth/Register';
import { live } from '../define';
import { moved } from '../moved';
import type { MovedRoute } from '../moved';
import type { RouteDefinition } from '../types';

// Area: auth. Signing in, registering, password reset and the invitation link.
// [impl->req~frontend-nav-reset-single-screen~1]

const AcceptInvitation = lazy(() => import('../../pages/Invitations/AcceptInvitation').then((module) => ({ default: module.AcceptInvitation })));

export const routes: RouteDefinition[] = [
  live('auth-login', '/login', <Login />),
  live('auth-register', '/register', <Register />),
  live('auth-reset-request', '/password-reset', <PasswordResetPage />),
  live('auth-cas-callback', '/auth/cas/callback', <CasCallback />),
  live('org-invite-accept', '/invitations/accept', <AcceptInvitation />, { sessionHeader: true }),
];

// The reset e-mail of the gateway links to the second screen that used to exist: its address stays valid for good.
const movedAddresses: MovedRoute[] = [
  moved('reset-complete-link', '/password-reset/complete', '/password-reset', { permanent: true }),
];

// The registry reads `moved` from every area module.
export { movedAddresses as moved };
