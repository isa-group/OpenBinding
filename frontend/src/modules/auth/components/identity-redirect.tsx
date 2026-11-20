// Adapted from SPHERE frontend/src/modules/auth/components/identity-redirect.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's `login_url` and string `state.from`, sanitised by `safeReturnPath` (SPHERE builds `returnTo` from any
// `from`); one sign-in URL for logging in and signing up, since SCORETech Identity registers an unknown email from its sign-in
// page; a page per closed `identity_error` code, each with Try again, so a refusal never loops; SPHERE's split auth layout;
// `consumeConsentReturn` dropped (OAuth consent arrives with F7/F9); IdentityCallback reads OpenBinding's AuthProvider.

import { useEffect, useRef, type ReactNode } from 'react';
import { Helmet } from 'react-helmet-async';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthConfig } from '../contexts/authConfigContext';
import { useAuth } from '../hooks/useAuth';
import { safeReturnPath } from '../utils/authFlow';
import { LEDE, PRIMARY_ACTION, TITLE } from '../utils/classes';
import AuthLayout from './auth-layout';

/** The closed list of codes the gateway's callback sends back (`docs/ERRORS.md`). */
export const IDENTITY_ERRORS = {
  signin_failed: {
    title: 'Sign-in could not be completed',
    body: 'SCORETech Identity didn’t finish signing you in. Nothing was changed; you can safely try again.',
  },
  account_not_linked: {
    title: 'This email belongs to another account',
    body: 'An OpenBinding account that isn’t linked to SCORETech Identity already uses this verified email. OpenBinding never links accounts by email: ask an administrator to help you, or sign in to SCORETech Identity with another email.',
  },
  access_denied: {
    title: 'Your SCORETech account can’t use OpenBinding yet',
    body: 'SCORETech Identity hasn’t granted your account access to OpenBinding. Ask the SCORE Lab administrators for access, then try again.',
  },
  unavailable: {
    title: 'SCORETech Identity is unavailable',
    body: 'OpenBinding couldn’t reach SCORETech Identity to sign you in. Try again in a few minutes.',
  },
  expired: {
    title: 'Your sign-in expired',
    body: 'The sign-in took too long or was opened in another tab, so it was cancelled. You can safely try again.',
  },
  account_disabled: {
    title: 'This account is disabled',
    body: 'An administrator has disabled this OpenBinding account. Contact them if you think this is a mistake.',
  },
} as const;

export type IdentityErrorCode = keyof typeof IDENTITY_ERRORS;

function copyFor(code: string): { title: string; body: string } {
  return code in IDENTITY_ERRORS
    ? IDENTITY_ERRORS[code as IdentityErrorCode]
    : IDENTITY_ERRORS.signin_failed;
}

/** Where the person was going (router state `from`, or `?returnTo=`), if it is an internal page a sign-in may return to. */
function returnTarget(from: unknown, requested: string | null): string {
  return safeReturnPath(from) ?? safeReturnPath(requested) ?? '/';
}

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthLayout>
      <Helmet>
        <title>{`OpenBinding - ${title}`}</title>
      </Helmet>
      <div className="flex flex-col">
        <h1 className={TITLE}>{title}</h1>
        {children}
      </div>
    </AuthLayout>
  );
}

/**
 * `/authentication` in SCORETech mode: the browser goes to the gateway's sign-in route, which sends it to SCORETech Identity.
 * With `?identity_error=` it stays and says what went wrong, with Try again, so a refusal never loops.
 */
export function IdentityRedirect() {
  const config = useAuthConfig();
  const location = useLocation();
  const [params] = useSearchParams();
  const error = params.get('identity_error');
  const target = returnTarget(
    (location.state as { from?: unknown } | null)?.from,
    params.get('returnTo')
  );
  const url = new URL(config.login_url ?? '', window.location.origin);
  url.searchParams.set('returnTo', target);
  const href = url.href;
  // Once per target, however often StrictMode runs the effect.
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (error || sent.current === href) return;
    sent.current = href;
    window.location.replace(href);
  }, [href, error]);
  if (!error)
    return (
      <Screen title="Opening SCORETech Identity…">
        <p className={LEDE}>Use your shared SCORE account to continue.</p>
        <a className={`mt-7 ${PRIMARY_ACTION}`} href={href}>
          Continue to SCORETech Identity
        </a>
      </Screen>
    );
  const copy = copyFor(error);
  return (
    <Screen title={copy.title}>
      <p className={LEDE} data-identity-error={error in IDENTITY_ERRORS ? error : 'signin_failed'}>
        {copy.body}
      </p>
      <a className={`mt-7 ${PRIMARY_ACTION}`} href={href}>
        Try again
      </a>
    </Screen>
  );
}

/** `/sso/identity/callback`: the gateway set the session cookie; wait for the session, then go where the person was going. */
export function IdentityCallback() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const destination = useRef<string | null>(null);
  const safe = safeReturnPath(params.get('returnTo')) ?? '/';
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate('/authentication?identity_error=signin_failed', { replace: true });
      return;
    }
    // StrictMode may run the effect twice: the first decision is the one navigated to.
    destination.current ??= safe;
    navigate(destination.current, { replace: true });
  }, [loading, user, navigate, safe]);
  return (
    <p className="p-8 text-tp-steel" role="status">
      Signing you in…
    </p>
  );
}

/** A local-mode screen (the password reset): in SCORETech mode Identity manages passwords, so it goes to sign-in instead. */
export function IdentityAwareLocalPage({ children }: { children: ReactNode }) {
  return useAuthConfig().provider === 'scoretech' ? <IdentityRedirect /> : <>{children}</>;
}
