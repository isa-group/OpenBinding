import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { Notice } from '../../components/ui/Notice';
import { classifyAuthError, fieldErrorsFrom } from './authErrors';
import { AuthField, AuthShell, AuthSpinner } from './AuthShell';
import { MIN_PASSWORD_LENGTH, passwordStrength } from './passwordStrength';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Ask for a one-time reset link. The answer never says whether the address has an account. */
export function PasswordResetRequestPage() {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'invalid' | 'unknown' | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const emailOk = EMAIL_PATTERN.test(email);
  const emailError = (touched && !emailOk) || failure === 'invalid' ? 'Enter a valid email address.' : undefined;
  const sent = delivery !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    if (!emailOk) {
      setTouched(true);
      emailRef.current?.focus();
      return;
    }
    setTouched(false);
    setBusy(true);
    try {
      const result = await apiClient.requestPasswordReset(email.trim());
      setDelivery(result.delivery);
    } catch (caught) {
      const result = classifyAuthError(caught);
      setFailure(result.kind === 'invalid' ? 'invalid' : result.kind === 'unavailable' || result.kind === 'network' ? 'unavailable' : 'unknown');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell backTo="/login" backLabel="Back">
      <span className={`auth-icon-tile${sent ? ' is-ok' : ''}`} aria-hidden="true"><Mail /></span>
      <h1 className="auth-title">{sent ? 'Check your inbox' : 'Forgot your password?'}</h1>
      <p className="auth-lede">
        {sent
          ? (delivery === 'email'
            ? 'If an account exists for that email, we’ve sent it a one-time link to set a new password.'
            : 'If an account exists for that email, reset instructions are now available to the operator of this deployment.')
          : 'Enter the email you signed up with. We’ll send a one-time link to set a new password. We never reveal whether an address has an account.'}
      </p>

      {!sent && (
        <>
          <div aria-live="assertive" className="auth-notices auth-spaced">
            {failure === 'unavailable' && (
              <Notice tone="error">We can’t send email right now (503). Nothing was sent; try again in a few minutes.</Notice>
            )}
            {failure === 'unknown' && <Notice tone="error">Password reset is unavailable right now. Try again later.</Notice>}
          </div>
          <form className="auth-form" onSubmit={submit} noValidate>
            <AuthField
              id="reset-email"
              name="email"
              label="Email address"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.org"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
              error={emailError}
              inputRef={emailRef}
            />
            <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
              {busy && <AuthSpinner />}
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </>
      )}

      {sent && (
        <div className="auth-actions auth-spaced">
          <p role="status" className="auth-lede">The link works once and expires. If nothing arrives, check spam or request a new link.</p>
          <button type="button" className="auth-btn auth-btn-secondary" onClick={() => setDelivery(null)}>Send another link</button>
        </div>
      )}

      <Link className="auth-link auth-spaced" to="/login" viewTransition>Back to log in</Link>
    </AuthShell>
  );
}

type TokenState = 'ready' | 'missing' | 'refused' | 'used';

const TOKEN_CHIP: Record<TokenState, { label: string; tone: 'ok' | 'bad' | 'warn' | 'plain' }> = {
  ready: { label: 'ready to use', tone: 'ok' },
  missing: { label: 'missing', tone: 'warn' },
  refused: { label: 'not accepted', tone: 'bad' },
  used: { label: 'used', tone: 'plain' },
};

/** Spend the one-time token from the reset link and set the new password. */
export function PasswordResetCompletePage() {
  const location = useLocation();
  const navigate = useNavigate();
  // The token is read once and kept here: the link's address stops carrying it as soon as the page has it.
  const [token] = useState(() => new URLSearchParams(location.search).get('token') ?? '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const [done, setDone] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'unknown' | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);

  // A one-time secret must not stay in the address bar, the history or a later referrer.
  useEffect(() => {
    if (new URLSearchParams(location.search).has('token')) {
      const rest = new URLSearchParams(location.search);
      rest.delete('token');
      const search = rest.toString();
      navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  const state: TokenState = done ? 'used' : !token ? 'missing' : refused ? 'refused' : 'ready';
  const chip = TOKEN_CHIP[state];
  const strength = passwordStrength(password);
  const passwordOk = password.length >= MIN_PASSWORD_LENGTH;
  const passwordError = (touched && !passwordOk ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined) ?? serverError ?? undefined;
  const confirmationError = touched && confirmation !== password ? 'The passwords don’t match.' : undefined;

  const copy = {
    ready: { title: 'Set a new password', intro: 'Choose a new password for your account. The link in your email works once.' },
    missing: {
      title: 'This link is incomplete',
      intro: 'The page needs the one-time token from your email. Open the link exactly as received, or request a new one.',
    },
    refused: {
      title: 'This reset link can’t be used',
      intro: 'It’s invalid, expired or was already used: the gateway doesn’t say which. Each link works once and expires, so request a new one.',
    },
    used: {
      title: 'Password changed',
      intro: 'You can log in with your new password. Sessions that were open with the old one have been signed out.',
    },
  }[state];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setServerError(null);
    if (!token) return;
    if (!passwordOk || confirmation !== password) {
      setTouched(true);
      (!passwordOk ? passwordRef : confirmationRef).current?.focus();
      return;
    }
    setTouched(false);
    setBusy(true);
    try {
      await apiClient.completePasswordReset(token, password);
      setDone(true);
      setPassword('');
      setConfirmation('');
    } catch (caught) {
      const result = classifyAuthError(caught);
      if (result.kind === 'rejected' || result.kind === 'not-found') {
        setRefused(true);
      } else if (result.kind === 'invalid') {
        setServerError(fieldErrorsFrom(caught).new_password
          ?? (result.code === 'weak_password' && result.message ? result.message : `This password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters.`));
      } else {
        setFailure(result.kind === 'unavailable' || result.kind === 'network' ? 'unavailable' : 'unknown');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell backTo="/login" backLabel="Back">
      <span className={`auth-icon-tile${state === 'used' ? ' is-ok' : state === 'missing' || state === 'refused' ? ' is-bad' : ''}`} aria-hidden="true">
        <KeyRound />
      </span>
      <h1 className="auth-title">{copy.title}</h1>
      <p className="auth-lede">{copy.intro}</p>
      <span className={`auth-token-chip is-${chip.tone}`}>Reset link · {chip.label}</span>

      {state === 'ready' && (
        <>
          <div aria-live="assertive" className="auth-notices auth-spaced">
            {failure === 'unavailable' && (
              <Notice tone="error">The password couldn’t be changed because OpenBinding isn’t reachable right now. Your link is still valid; try again.</Notice>
            )}
            {failure === 'unknown' && <Notice tone="error">The password could not be changed. Try again in a moment.</Notice>}
          </div>
          <form className="auth-form auth-spaced" onSubmit={submit} noValidate>
            <AuthField
              id="reset-password"
              name="password"
              label="New password"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              error={passwordError}
              inputRef={passwordRef}
              below={(
                <div className="auth-strength">
                  <span className="auth-strength-bars" aria-hidden="true">
                    {[1, 2, 3].map((level) => <i key={level} className={strength.level >= level ? 'is-on' : undefined} />)}
                  </span>
                  <span className="auth-strength-label">Strength: {strength.label}</span>
                </div>
              )}
            />
            <AuthField
              id="reset-confirmation"
              name="confirmation"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat the password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
              error={confirmationError}
              inputRef={confirmationRef}
            />
            <button type="submit" className="auth-btn auth-btn-primary" disabled={busy}>
              {busy && <AuthSpinner />}
              {busy ? 'Saving…' : 'Set new password'}
            </button>
          </form>
        </>
      )}

      {(state === 'missing' || state === 'refused') && (
        <Link className="auth-btn auth-btn-primary auth-spaced" to="/password-reset" viewTransition>Request a new link</Link>
      )}
      {state === 'used' && (
        <Link
          className="auth-btn auth-btn-primary auth-spaced"
          to="/login"
          state={{ notice: 'Password changed. Log in with the new password.' }}
          viewTransition
        >
          Continue to log in
        </Link>
      )}
      <Link className="auth-link auth-spaced" to="/login" viewTransition>Back to log in</Link>
    </AuthShell>
  );
}
