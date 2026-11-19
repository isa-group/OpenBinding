// Adapted from SPHERE frontend/src/modules/auth/components/login-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's local sign-in (no SSO buttons: SCORETech Identity replaces this form in its mode), its field checks and refusal wording, the notice of a
// session that ended, the "already signed in" state, and the return to the page that asked for the session; no e-mail
// verification link (OpenBinding accounts are not verified by e-mail).

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FiCheck } from 'react-icons/fi';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { classifyAuthError } from '../../../core/api/errors';
import { Notice } from '../../../core/components/notice';
import ServiceStatus from '../../../presentation/components/service-status';
import {
  afterSignInTarget,
  clearSignInNote,
  hasRecentSignIn,
  hasSessionEnded,
  noteSignInStarted,
} from '../../utils/authFlow';
import { useAuth } from '../../hooks/useAuth';
import { fieldErrorsFrom } from '../../utils/authErrors';
import {
  ICON_TILE,
  LEDE,
  PRIMARY_ACTION,
  SECONDARY_ACTION,
  TEXT_LINK,
  TITLE,
} from '../../utils/classes';
import { AuthField, AuthSpinner } from '../auth-field';
import { fadeUp } from '../auth-layout/variants';

interface LoginState {
  from?: string;
  notice?: string;
}

type Failure = 'rejected' | 'unavailable' | 'network' | 'invalid' | 'busy';

/** Log in with a username or email and a password (local mode). */
export default function LoginForm() {
  const { signIn, signOut, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginState | null;
  const target = afterSignInTarget(state?.from);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [serverFields, setServerFields] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Read once: the notice must survive the re-renders of typing, and the flag is cleared by the next sign-in.
  const [sessionEnded] = useState(hasSessionEnded);
  // True in the instance that replaces this screen when the sign-in lands (see noteSignInStarted): it continues
  // to the page the person asked for instead of telling them they are already signed in.
  const [returning] = useState(hasRecentSignIn);
  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user || !returning) return;
    clearSignInNote();
    navigate(target, { replace: true });
  }, [user, returning, target, navigate]);

  const identifierError =
    touched && !identifier.trim()
      ? 'Enter your username or email.'
      : serverFields.username_or_email;
  const passwordError = touched && !password ? 'Enter your password.' : serverFields.password;
  const credentialsRefused = failure === 'rejected';

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setServerFields({});
    if (!identifier.trim() || !password) {
      setTouched(true);
      (identifier.trim() ? passwordRef : identifierRef).current?.focus();
      return;
    }
    setTouched(false);
    setBusy(true);
    noteSignInStarted();
    try {
      await signIn(identifier.trim(), password);
      setDone(true);
      navigate(target, { replace: true });
      // Long enough for the instance that replaces this one to read it, short enough not to outlive the visit.
      window.setTimeout(clearSignInNote, 2000);
    } catch (caught) {
      clearSignInNote();
      // The gateway answers a wrong password and an unknown account in the same words, and so does this:
      // saying which would tell an unauthenticated visitor who has an account here.
      const result = classifyAuthError(caught);
      if (
        result.kind === 'unavailable' ||
        result.kind === 'network' ||
        result.kind === 'invalid' ||
        result.kind === 'busy'
      ) {
        setFailure(result.kind);
        if (result.kind === 'invalid') setServerFields(fieldErrorsFrom(caught));
      } else {
        setFailure('rejected');
      }
    } finally {
      setBusy(false);
    }
  };

  if (user && !busy && !done && !returning) {
    return (
      <div className="flex flex-col">
        <motion.div variants={fadeUp} className="mb-8">
          <h1 className={TITLE}>You’re already signed in</h1>
          <p className={LEDE}>
            Signed in as {user.username} ({user.email}).
          </p>
        </motion.div>
        <motion.div variants={fadeUp} className="flex flex-col gap-3">
          <Link className={PRIMARY_ACTION} to={target} viewTransition>
            Continue to your workspace
          </Link>
          <button type="button" className={SECONDARY_ACTION} onClick={() => void signOut()}>
            Log in as someone else
          </button>
        </motion.div>
      </div>
    );
  }

  if (done || (user && returning)) {
    return (
      <div className="flex flex-col" role="status">
        <div className={ICON_TILE} aria-hidden="true">
          <FiCheck className="h-7 w-7 text-emerald-600" />
        </div>
        <h1 className={TITLE}>Welcome back</h1>
        <p className={LEDE}>
          You’re signed in. Taking you back to the page you asked for, or to your workspace.
        </p>
        <Link className={`${PRIMARY_ACTION} mt-7`} to={target} viewTransition>
          Continue
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <motion.div variants={fadeUp} className="mb-8">
        <h1 className={TITLE}>Welcome back</h1>
        <p className={LEDE}>Log in to your OpenBinding account.</p>
      </motion.div>

      {(sessionEnded || state?.notice) && (
        <div className="mb-5 flex flex-col gap-2">
          {sessionEnded && (
            <Notice tone="info">
              Your session ended and couldn’t be renewed. Log in again and you’ll return to where
              you were.
            </Notice>
          )}
          {state?.notice && <Notice tone="success">{state.notice}</Notice>}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-tp-steel" role="status">
          Checking your session…
        </p>
      ) : (
        <>
          {/* Refusals */}
          <div aria-live="assertive" className="mb-4 flex flex-col gap-2 empty:hidden">
            {credentialsRefused && (
              <Notice tone="error">
                That username or email and password don’t match an active account. Check both and
                try again.
              </Notice>
            )}
            {failure === 'unavailable' && (
              <Notice tone="error">
                Sign-in is unavailable right now (503). Accounts aren’t reachable from this
                deployment; public pages still work.
                <ServiceStatus className="mt-2" />
              </Notice>
            )}
            {failure === 'network' && (
              <Notice tone="error">
                OpenBinding couldn’t be reached. Check your connection and try again.
                <ServiceStatus className="mt-2" />
              </Notice>
            )}
            {failure === 'busy' && (
              <Notice tone="error">Too many sign-in attempts. Wait a moment and try again.</Notice>
            )}
            {failure === 'invalid' && (
              <Notice tone="error">
                The gateway didn’t accept those details. Check both fields and try again.
              </Notice>
            )}
          </div>

          {/* Form */}
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <AuthField
              id="login-identifier"
              name="identifier"
              label="Username or email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Enter your username or email"
              value={identifier}
              onChange={event => setIdentifier(event.target.value)}
              disabled={busy}
              error={identifierError}
              invalid={credentialsRefused}
              inputRef={identifierRef}
            />
            <AuthField
              id="login-password"
              name="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              disabled={busy}
              error={passwordError}
              invalid={credentialsRefused}
              inputRef={passwordRef}
              aside={
                <Link className={`text-sm ${TEXT_LINK}`} to="/forgot-password" viewTransition>
                  Forgot password?
                </Link>
              }
            />
            <motion.div variants={fadeUp} className="pt-2">
              <button type="submit" className={PRIMARY_ACTION} disabled={busy}>
                {busy && <AuthSpinner />}
                {busy ? 'Signing in…' : 'Log in'}
              </button>
              <span className="sr-only" role="status" aria-live="polite">
                {busy ? 'Signing in' : ''}
              </span>
            </motion.div>
          </form>

          {/* Footer */}
          <motion.p variants={fadeUp} className="mt-8 text-center text-sm text-tp-steel">
            Don’t have an account?{' '}
            <Link
              className={TEXT_LINK}
              to="/authentication?view=register"
              state={state?.from ? { from: state.from } : undefined}
              viewTransition
            >
              Create one
            </Link>
          </motion.p>
        </>
      )}
    </div>
  );
}
