// Adapted from SPHERE frontend/src/modules/auth/components/register-form/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's account fields and rules (username, email and a password of at least ten characters, with its strength
// meter) instead of names, phone and address; no SSO buttons (CAS creates its account on the login view); a new account is
// signed in at once and sent where it was heading, with no e-mail verification; the refusal wording and the free-plan note.

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FiCheck } from 'react-icons/fi';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { classifyAuthError } from '../../../core/api/errors';
import { Notice } from '../../../core/components/notice';
import {
  afterSignInTarget,
  clearSignInNote,
  hasRecentSignIn,
  noteSignInStarted,
} from '../../../../utils/authFlow';
import { useAuth } from '../../hooks/useAuth';
import { fieldErrorsFrom, type FieldErrors } from '../../utils/authErrors';
import {
  ICON_TILE,
  LEDE,
  PRIMARY_ACTION,
  SECONDARY_ACTION,
  TEXT_LINK,
  TITLE,
} from '../../utils/classes';
import { MIN_PASSWORD_LENGTH } from '../../utils/passwordStrength';
import { AuthField, AuthSpinner } from '../auth-field';
import { fadeUp } from '../auth-layout/variants';
import PasswordStrengthMeter from '../password-strength';

// The gateway's own rules, so that a refusal happens before the round trip.
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RULE = '3 to 64 characters: letters, digits, dot, underscore or hyphen.';

type Failure = 'conflict' | 'unavailable' | 'network' | 'unknown';

interface RegisterState {
  from?: string;
}

/** Create an account. A new account is signed in straight away and sent where it was heading. */
export default function RegisterForm() {
  const { register, signOut, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as RegisterState | null;
  const target = afterSignInTarget(state?.from);
  const carried = state?.from ? { from: state.from } : undefined;
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
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

  const usernameError =
    (touched && !usernameOk ? USERNAME_RULE : undefined) ?? serverFields.username;
  const emailError =
    (touched && !emailOk ? 'Enter a valid email address.' : undefined) ?? serverFields.email;
  const passwordError =
    (touched && !passwordOk
      ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
      : undefined) ?? serverFields.password;

  const missing = MIN_PASSWORD_LENGTH - password.length;
  const passwordHint = !password
    ? `At least ${MIN_PASSWORD_LENGTH} characters. Length is the only rule.`
    : passwordOk
      ? `✓ At least ${MIN_PASSWORD_LENGTH} characters`
      : `${missing} more ${missing === 1 ? 'character' : 'characters'} needed`;

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
        if (result.code === 'weak_password')
          fields.password = result.message || 'That password is not acceptable. Try a longer one.';
        if (!Object.keys(fields).length)
          fields.password = 'That password is not acceptable. Try a longer one.';
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
      <div className="flex flex-col">
        <motion.div variants={fadeUp} className="mb-8">
          <h1 className={TITLE}>You already have an account</h1>
          <p className={LEDE}>
            Signed in as {user.username}. Log out first to create another account.
          </p>
        </motion.div>
        <motion.div variants={fadeUp} className="flex flex-col gap-3">
          <Link className={PRIMARY_ACTION} to={target} viewTransition>
            Continue to your workspace
          </Link>
          <button type="button" className={SECONDARY_ACTION} onClick={() => void signOut()}>
            Log out
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
        <h1 className={TITLE}>Your account is ready</h1>
        <p className={LEDE}>
          You’re signed in{user ? ` on the ${user.plan} plan` : ''}. Taking you to{' '}
          {target === '/' ? 'your dashboard' : 'the page you asked for'}.
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
      <motion.div variants={fadeUp} className="mb-6">
        <h1 className={TITLE}>Create your account</h1>
        <p className={LEDE}>Free to start. No payment details.</p>
      </motion.div>

      {/* Refusals */}
      <div aria-live="assertive" className="mb-4 flex flex-col gap-2 empty:hidden">
        {failure === 'conflict' && (
          <Notice tone="error">
            That username or email is already registered (409).{' '}
            <Link className="underline" to="/authentication" state={carried}>
              Log in
            </Link>{' '}
            or{' '}
            <Link className="underline" to="/forgot-password">
              reset your password
            </Link>
            .
          </Notice>
        )}
        {failure === 'unavailable' && (
          <Notice tone="error">
            Accounts can’t be created right now (503). Nothing was saved; try again later.
          </Notice>
        )}
        {failure === 'network' && (
          <Notice tone="error">
            OpenBinding couldn’t be reached. Nothing was saved; check your connection and try again.
          </Notice>
        )}
        {failure === 'unknown' && (
          <Notice tone="error">The account could not be created. Try again in a moment.</Notice>
        )}
      </div>

      {/* Form */}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <AuthField
          id="register-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="e.g. ada.lovelace"
          value={username}
          onChange={event => setUsername(event.target.value)}
          disabled={busy}
          error={usernameError}
          hint={username && usernameOk ? '✓ Looks good' : USERNAME_RULE}
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
          onChange={event => setEmail(event.target.value)}
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
          onChange={event => setPassword(event.target.value)}
          disabled={busy}
          error={passwordError}
          hint={passwordHint}
          hintTone={password && passwordOk ? 'ok' : 'neutral'}
          inputRef={passwordRef}
          below={<PasswordStrengthMeter value={password} />}
        />
        <motion.div variants={fadeUp} className="pt-2">
          <button type="submit" className={PRIMARY_ACTION} disabled={busy}>
            {busy && <AuthSpinner />}
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </motion.div>
      </form>

      {/* The plan a new account starts on */}
      <motion.div
        variants={fadeUp}
        className="mt-6 rounded-lg border border-tp-hairline-soft bg-tp-surface px-4 py-3 text-sm"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-tp-ink">New accounts start on the free plan</span>
          <Link className={`shrink-0 ${TEXT_LINK}`} to="/pricing" viewTransition>
            Compare plans
          </Link>
        </div>
        <p className="mt-1 text-xs leading-5 text-tp-steel">
          Your allowances and plan are on your account page once you’re in. A verified Universidad
          de Sevilla CAS identity can move you to RESEARCH later.
        </p>
      </motion.div>

      {/* Footer */}
      <motion.p variants={fadeUp} className="mt-8 text-center text-sm text-tp-steel">
        Already have an account?{' '}
        <Link className={TEXT_LINK} to="/authentication" state={carried} viewTransition>
          Log in
        </Link>
      </motion.p>
    </div>
  );
}
