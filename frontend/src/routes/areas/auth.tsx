import { lazy } from 'react';
import { CasCallback } from '../../pages/Auth/CasCallback';
import { Login } from '../../pages/Auth/Login';
import { PasswordResetPage } from '../../pages/Auth/PasswordReset';
import { Register } from '../../pages/Auth/Register';
import { live } from '../define';
import type { RouteDefinition } from '../types';

// Area: auth. Signing in, registering, password reset and the invitation link.

const AcceptInvitation = lazy(() =>
  import('../../pages/Invitations/AcceptInvitation').then(module => ({
    default: module.AcceptInvitation,
  }))
);

export const routes: RouteDefinition[] = [
  live('auth-login', '/login', <Login />),
  live('auth-register', '/register', <Register />),
  live('auth-reset-request', '/password-reset', <PasswordResetPage />),
  live('auth-cas-callback', '/auth/cas/callback', <CasCallback />),
  live('org-invite-accept', '/invitations/accept', <AcceptInvitation />, { sessionHeader: true }),
];
