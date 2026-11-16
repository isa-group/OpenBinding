// Adapted from SPHERE frontend/src/modules/auth/pages/reset-password/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's completion (`POST /v1/auth/password-reset/complete`) and its rule (at least ten characters, with the
// strength meter); the link's state is shown (ready, not accepted, used); a refused link retires the form, a weak password or
// an outage keeps it and the token; the way on to log in carries a notice.

import { motion } from 'framer-motion';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { FiKey } from 'react-icons/fi';
import { Link, useSearchParams } from 'react-router-dom';
import { apiClient } from '../../../../api/client';
import { classifyAuthError } from '../../../core/api/errors';
import { Notice } from '../../../core/components/notice';
import { AuthField, AuthSpinner } from '../../components/auth-field';
import AuthLayout from '../../components/auth-layout';
import { fadeUp } from '../../components/auth-layout/variants';
import PasswordStrengthMeter from '../../components/password-strength';
import { fieldErrorsFrom } from '../../utils/authErrors';
import { ICON_TILE, LEDE, PRIMARY_ACTION, TEXT_LINK, TITLE } from '../../utils/classes';
import { MIN_PASSWORD_LENGTH } from '../../utils/passwordStrength';

type TokenState = 'missing' | 'ready' | 'refused' | 'used';

const CHIP: Record<TokenState, { label: string; className: string }> = {
  missing: { label: 'missing', className: 'border-red-200 bg-red-50 text-red-800' },
  ready: { label: 'ready to use', className: 'border-emerald-200 bg-emerald-50 text-emerald-800' },
  refused: { label: 'not accepted', className: 'border-red-200 bg-red-50 text-red-800' },
  used: { label: 'used', className: 'border-tp-hairline-soft bg-tp-surface text-tp-slate' },
};

const COPY: Record<TokenState, { title: string; intro: string }> = {
  missing: {
    title: 'This reset link can’t be used',
    intro:
      'The address has no reset token. Open the link from your email again, or request a new one.',
  },
  ready: {
    title: 'Set a new password',
    intro: 'Choose a new password for your account. The link in your email works once.',
  },
  refused: {
    title: 'This reset link can’t be used',
    intro:
      'It’s invalid, expired or was already used: the gateway doesn’t say which. Each link works once and expires, so request a new one.',
  },
  used: {
    title: 'Password changed',
    intro:
      'You can log in with your new password. Sessions that were open with the old one have been signed out.',
  },
};

/** `/reset-password?token=`: spend the one-time token of the reset email and set the new password. */
export default function ResetPasswordPage() {
  const [query] = useSearchParams();
  const token = query.get('token') ?? '';
  return (
    <AuthLayout backTo="/authentication">
      <Helmet>
        <title>OpenBinding - Reset password</title>
      </Helmet>
      {token ? <NewPasswordForm key={token} token={token} /> : <Outcome state="missing" />}
    </AuthLayout>
  );
}

/** The heading of the screen: the link's state, what it means, and its chip. */
function Outcome({ state }: { state: TokenState }) {
  const chip = CHIP[state];
  const copy = COPY[state];
  return (
    <div className="flex flex-col">
      <motion.div variants={fadeUp}>
        <div className={ICON_TILE} aria-hidden="true">
          <FiKey
            className={`h-7 w-7 ${
              state === 'used'
                ? 'text-emerald-600'
                : state === 'ready'
                  ? 'text-tp-accent'
                  : 'text-red-600'
            }`}
          />
        </div>
        <h1 className={TITLE}>{copy.title}</h1>
        <p className={LEDE}>{copy.intro}</p>
        <span
          className={`mt-4 inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${chip.className}`}
        >
          Reset link · {chip.label}
        </span>
      </motion.div>

      {(state === 'missing' || state === 'refused') && (
        <Link className={`${PRIMARY_ACTION} mt-7`} to="/forgot-password" viewTransition>
          Request a new link
        </Link>
      )}
      {state === 'used' && (
        <Link
          className={`${PRIMARY_ACTION} mt-7`}
          to="/authentication"
          state={{ notice: 'Password changed. Log in with the new password.' }}
          viewTransition
        >
          Continue to log in
        </Link>
      )}
      {state !== 'ready' && <BackToLogIn />}
    </div>
  );
}

function BackToLogIn() {
  return (
    <Link className={`mt-6 text-center text-sm ${TEXT_LINK}`} to="/authentication" viewTransition>
      Back to log in
    </Link>
  );
}

function NewPasswordForm({ token }: { token: string }) {
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

  const passwordOk = password.length >= MIN_PASSWORD_LENGTH;
  const passwordError =
    (touched && !passwordOk ? `Use at least ${MIN_PASSWORD_LENGTH} characters.` : undefined) ??
    serverError ??
    undefined;
  const confirmationError =
    touched && confirmation !== password ? 'The passwords don’t match.' : undefined;

  if (done) return <Outcome state="used" />;
  if (refused) return <Outcome state="refused" />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setServerError(null);
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
        setServerError(
          fieldErrorsFrom(caught).new_password ??
            (result.code === 'weak_password' && result.message
              ? result.message
              : `This password is too weak. Use at least ${MIN_PASSWORD_LENGTH} characters.`)
        );
      } else {
        setFailure(
          result.kind === 'unavailable' || result.kind === 'network' ? 'unavailable' : 'unknown'
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <Outcome state="ready" />

      <div aria-live="assertive" className="mt-5 flex flex-col gap-2 empty:hidden">
        {failure === 'unavailable' && (
          <Notice tone="error">
            The password couldn’t be changed because OpenBinding isn’t reachable right now. Your
            link is still valid; try again.
          </Notice>
        )}
        {failure === 'unknown' && (
          <Notice tone="error">The password could not be changed. Try again in a moment.</Notice>
        )}
      </div>

      <form className="mt-7 flex flex-col gap-4" onSubmit={submit} noValidate>
        <AuthField
          id="reset-password"
          name="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={event => setPassword(event.target.value)}
          disabled={busy}
          error={passwordError}
          inputRef={passwordRef}
          below={<PasswordStrengthMeter value={password} />}
        />
        <AuthField
          id="reset-confirmation"
          name="confirmation"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat the password"
          value={confirmation}
          onChange={event => setConfirmation(event.target.value)}
          disabled={busy}
          error={confirmationError}
          inputRef={confirmationRef}
        />
        <motion.div variants={fadeUp} className="pt-2">
          <button type="submit" className={PRIMARY_ACTION} disabled={busy}>
            {busy && <AuthSpinner />}
            {busy ? 'Saving…' : 'Set new password'}
          </button>
        </motion.div>
      </form>

      <BackToLogIn />
    </div>
  );
}
