import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import {
  afterSignInTarget, clearSignInNote, hasRecentSignIn, hasSessionEnded, noteSignInStarted, rememberCasFlow,
} from '../../utils/authFlow';
import { classifyAuthError, fieldErrorsFrom } from './authErrors';
import { AuthField, AuthShell, AuthSpinner } from './AuthShell';

interface LoginState {
  from?: string;
  notice?: string;
}

/** Log in with a username or email and a password, or continue with the university's CAS. */
export function Login() {
  const { signIn, signOut, user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginState | null;
  const target = afterSignInTarget(state?.from);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<'rejected' | 'unavailable' | 'network' | 'invalid' | 'busy' | null>(null);
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

  const identifierError = touched && !identifier.trim() ? 'Enter your username or email.' : serverFields.username_or_email;
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
      if (result.kind === 'unavailable' || result.kind === 'network' || result.kind === 'invalid' || result.kind === 'busy') {
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
      <AuthShell>
        <div className="auth-stack">
          <h1 className="auth-title">You’re already signed in</h1>
          <p className="auth-lede">Signed in as {user.username} ({user.email}).</p>
          <Link className="auth-btn auth-btn-primary" to={target} viewTransition>Continue to your workspace</Link>
          <button type="button" className="auth-btn auth-btn-secondary" onClick={() => void signOut()}>Log in as someone else</button>
        </div>
      </AuthShell>
    );
  }

  if (done || (user && returning)) {
    return (
      <AuthShell>
        <div className="auth-stack" role="status">
          <span className="auth-icon-tile is-ok" aria-hidden="true"><Check /></span>
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-lede">You’re signed in. Taking you back to the page you asked for, or to your workspace.</p>
          <Link className="auth-btn auth-btn-primary" to={target} viewTransition>Continue</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div>
        <h1 className="auth-title">Welcome back</h1>
        <p className="auth-lede">Log in to your OpenBinding account.</p>
      </div>

      <div className="auth-notices auth-spaced">
        {sessionEnded && (
          <Notice tone="info">Your session ended and couldn’t be renewed. Log in again and you’ll return to where you were.</Notice>
        )}
        {state?.notice && <Notice tone="success">{state.notice}</Notice>}
      </div>

      {loading ? (
        <p className="auth-lede" role="status">Checking your session…</p>
      ) : (
        <>
          <a className="auth-cas" href={apiClient.casStartUrl('login')} onClick={() => rememberCasFlow('login', state?.from)}>
            <img src="/brands/us-fama.png" alt="" />
            Continue with Universidad de Sevilla (CAS)
          </a>
          <span className="auth-cas-note">
            A verified CAS identity can qualify for RESEARCH, but only if the current pricing grants it. It never gives admin or organization roles.
          </span>

          <div className="auth-divider" aria-hidden="true">or</div>

          <div aria-live="assertive" className="auth-notices">
            {credentialsRefused && (
              <Notice tone="error">That username or email and password don’t match an active account. Check both and try again.</Notice>
            )}
            {failure === 'unavailable' && (
              <Notice tone="error">
                Sign-in is unavailable right now (503). Accounts aren’t reachable from this deployment; public pages still work.{' '}
                <Link to="/status">Service status</Link>
              </Notice>
            )}
            {failure === 'network' && (
              <Notice tone="error">
                OpenBinding couldn’t be reached. Check your connection and try again. <Link to="/status">Service status</Link>
              </Notice>
            )}
            {failure === 'busy' && <Notice tone="error">Too many sign-in attempts. Wait a moment and try again.</Notice>}
            {failure === 'invalid' && <Notice tone="error">The gateway didn’t accept those details. Check both fields and try again.</Notice>}
          </div>

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <AuthField
              id="login-identifier"
              name="identifier"
              label="Username or email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Enter your username or email"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
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
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              error={passwordError}
              invalid={credentialsRefused}
              inputRef={passwordRef}
              aside={<Link to="/password-reset" viewTransition>Forgot password?</Link>}
            />
            <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
              {busy && <AuthSpinner />}
              {busy ? 'Signing in…' : 'Log in'}
            </button>
            <span className="sr-only" role="status" aria-live="polite">{busy ? 'Signing in' : ''}</span>
          </form>

          <p className="auth-switch">
            Don’t have an account? <Link to="/register" state={state?.from ? { from: state.from } : undefined} viewTransition>Create one</Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
