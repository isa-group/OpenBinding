import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Notice } from '../../components/ui/Notice';
import { useAuth } from '../../contexts/auth';
import { afterSignInTarget, clearSignInNote, hasRecentSignIn, noteSignInStarted } from '../../utils/authFlow';
import { classifyAuthError, fieldErrorsFrom, type FieldErrors } from './authErrors';
import { AuthField, AuthShell, AuthSpinner } from './AuthShell';
import { MIN_PASSWORD_LENGTH } from './passwordStrength';

// The gateway's own rules, so that a refusal happens before the round trip.
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RULE = '3 to 64 characters: letters, digits, dot, underscore or hyphen.';

type Failure = 'conflict' | 'unavailable' | 'network' | 'unknown' | null;

interface RegisterState {
  from?: string;
}

/** Create an account. A new account is signed in straight away and sent where it was heading. */
export function Register() {
  const { register, signOut, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as RegisterState | null;
  const target = afterSignInTarget(state?.from);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<Failure>(null);
  const [serverFields, setServerFields] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // True in the instance that replaces this screen when the new account is signed in (see noteSignInStarted).
  const [returning] = useState(hasRecentSignIn);
  const usernameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const usernameOk = USERNAME_PATTERN.test(username);
  const emailOk = EMAIL_PATTERN.test(email);
  const passwordOk = password.length >= MIN_PASSWORD_LENGTH;

  const usernameError = (touched && !usernameOk ? USERNAME_RULE : undefined) ?? serverFields.username;
  const emailError = (touched && !emailOk ? 'Enter a valid email address.' : undefined) ?? serverFields.email;
  const passwordError = (touched && !passwordOk ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` : undefined)
    ?? serverFields.password;

  const passwordHint = !password
    ? `At least ${MIN_PASSWORD_LENGTH} characters. Length is the only rule.`
    : passwordOk
      ? `✓ At least ${MIN_PASSWORD_LENGTH} characters`
      : `${MIN_PASSWORD_LENGTH - password.length} more ${MIN_PASSWORD_LENGTH - password.length === 1 ? 'character' : 'characters'} needed`;

  useEffect(() => {
    if (!user || !returning) return;
    clearSignInNote();
    navigate(target, { replace: true });
  }, [user, returning, target, navigate]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setServerFields({});
    if (!usernameOk || !emailOk || !passwordOk) {
      setTouched(true);
      const first = !usernameOk ? usernameRef : !emailOk ? emailRef : passwordRef;
      first.current?.focus();
      return;
    }
    setTouched(false);
    setBusy(true);
    noteSignInStarted();
    try {
      await register({ username, email, password });
      setDone(true);
      navigate(target, { replace: true });
      window.setTimeout(clearSignInNote, 2000);
    } catch (caught) {
      clearSignInNote();
      const result = classifyAuthError(caught);
      if (result.kind === 'conflict') {
        setFailure('conflict');
      } else if (result.kind === 'invalid') {
        const fields = fieldErrorsFrom(caught);
        if (result.code === 'weak_password') fields.password = result.message || 'That password is not acceptable. Try a longer one.';
        if (!Object.keys(fields).length) fields.password = 'That password is not acceptable. Try a longer one.';
        setServerFields(fields);
      } else if (result.kind === 'unavailable' || result.kind === 'network') {
        setFailure(result.kind);
      } else {
        setFailure('unknown');
      }
    } finally {
      setBusy(false);
    }
  };

  if (user && !busy && !done && !returning) {
    return (
      <AuthShell>
        <div className="auth-stack">
          <h1 className="auth-title">You already have an account</h1>
          <p className="auth-lede">Signed in as {user.username}. Log out first to create another account.</p>
          <Link className="auth-btn auth-btn-primary" to={target} viewTransition>Continue to your workspace</Link>
          <button type="button" className="auth-btn auth-btn-secondary" onClick={() => void signOut()}>Log out</button>
        </div>
      </AuthShell>
    );
  }

  if (done || (user && returning)) {
    return (
      <AuthShell>
        <div className="auth-stack" role="status">
          <span className="auth-icon-tile is-ok" aria-hidden="true"><Check /></span>
          <h1 className="auth-title">Your account is ready</h1>
          <p className="auth-lede">
            You’re signed in{user ? ` on the ${user.plan} plan` : ''}. Taking you to {target === '/app' ? 'your workspace' : 'the page you asked for'}.
          </p>
          <Link className="auth-btn auth-btn-primary" to={target} viewTransition>Continue</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div>
        <h1 className="auth-title">Create your account</h1>
        <p className="auth-lede">Free to start. No payment details.</p>
      </div>

      <div aria-live="assertive" className="auth-notices auth-spaced">
        {failure === 'conflict' && (
          <Notice tone="error">
            That username or email is already registered (409). <Link to="/login" state={state}>Log in</Link> or{' '}
            <Link to="/password-reset">reset your password</Link>.
          </Notice>
        )}
        {failure === 'unavailable' && (
          <Notice tone="error">Accounts can’t be created right now (503). Nothing was saved; try again later.</Notice>
        )}
        {failure === 'network' && (
          <Notice tone="error">OpenBinding couldn’t be reached. Nothing was saved; check your connection and try again.</Notice>
        )}
        {failure === 'unknown' && <Notice tone="error">The account could not be created. Try again in a moment.</Notice>}
      </div>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <AuthField
          id="register-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="e.g. ada.lovelace"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={busy}
          error={usernameError}
          hint={username ? (usernameOk ? '✓ Looks good' : USERNAME_RULE) : USERNAME_RULE}
          hintTone={username && usernameOk ? 'ok' : 'neutral'}
          inputRef={usernameRef}
        />
        <AuthField
          id="register-email"
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.org"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
          error={emailError}
          hint="Used to log in and to reach you."
          inputRef={emailRef}
        />
        <AuthField
          id="register-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
          error={passwordError}
          hint={passwordHint}
          hintTone={password && passwordOk ? 'ok' : 'neutral'}
          inputRef={passwordRef}
        />
        <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
          {busy && <AuthSpinner />}
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <div className="auth-plan">
        <span className="auth-plan-head">
          <span>New accounts start on the free plan</span>
          <Link to="/pricing" viewTransition>Compare plans</Link>
        </span>
        <p>Your allowances and plan are on your account page once you’re in. A verified Universidad de Sevilla CAS identity can move you to RESEARCH later.</p>
      </div>

      <p className="auth-switch">
        Already have an account? <Link to="/login" state={state?.from ? { from: state.from } : undefined} viewTransition>Log in</Link>
      </p>
    </AuthShell>
  );
}
