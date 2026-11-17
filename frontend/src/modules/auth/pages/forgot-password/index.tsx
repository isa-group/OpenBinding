// Adapted from SPHERE frontend/src/modules/auth/pages/forgot-password/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's request (`POST /v1/auth/password-reset/request`, by email only); the answer never says whether the
// address has an account, and says where the link went (email, or the deployment's operator); the email is checked before
// the round trip; refusals are named instead of shown as the server's message; another link can be asked for.

import { motion } from 'framer-motion';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { FiMail } from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { apiClient } from '../../../../api/client';
import { classifyAuthError } from '../../../core/api/errors';
import { Notice } from '../../../core/components/notice';
import { AuthField, AuthSpinner } from '../../components/auth-field';
import AuthLayout from '../../components/auth-layout';
import { fadeUp } from '../../components/auth-layout/variants';
import {
  ICON_TILE,
  LEDE,
  PRIMARY_ACTION,
  SECONDARY_ACTION,
  TEXT_LINK,
  TITLE,
} from '../../utils/classes';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** `/forgot-password`: ask for a one-time reset link. */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState<string | null>(null);
  const [failure, setFailure] = useState<'unavailable' | 'invalid' | 'unknown' | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const emailOk = EMAIL_PATTERN.test(email);
  const emailError =
    (touched && !emailOk) || failure === 'invalid' ? 'Enter a valid email address.' : undefined;
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
      setFailure(
        result.kind === 'invalid'
          ? 'invalid'
          : result.kind === 'unavailable' || result.kind === 'network'
            ? 'unavailable'
            : 'unknown'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout backTo="/authentication">
      <Helmet>
        <title>OpenBinding - Forgot password</title>
      </Helmet>
      <div className="flex flex-col">
        <motion.div variants={fadeUp}>
          <div className={ICON_TILE} aria-hidden="true">
            <FiMail className={`h-7 w-7 ${sent ? 'text-emerald-600' : 'text-tp-accent'}`} />
          </div>
          <h1 className={TITLE}>{sent ? 'Check your inbox' : 'Forgot your password?'}</h1>
          <p className={LEDE}>
            {sent
              ? delivery === 'email'
                ? 'If an account exists for that email, we’ve sent it a one-time link to set a new password.'
                : 'If an account exists for that email, reset instructions are now available to the operator of this deployment.'
              : 'Enter the email you signed up with. We’ll send a one-time link to set a new password. We never reveal whether an address has an account.'}
          </p>
        </motion.div>

        {!sent && (
          <>
            <div aria-live="assertive" className="mt-5 flex flex-col gap-2 empty:hidden">
              {failure === 'unavailable' && (
                <Notice tone="error">
                  We can’t send email right now (503). Nothing was sent; try again in a few minutes.
                </Notice>
              )}
              {failure === 'unknown' && (
                <Notice tone="error">
                  Password reset is unavailable right now. Try again later.
                </Notice>
              )}
            </div>
            <form className="mt-7 flex flex-col gap-4" onSubmit={submit} noValidate>
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
                onChange={event => setEmail(event.target.value)}
                disabled={busy}
                error={emailError}
                inputRef={emailRef}
              />
              <motion.div variants={fadeUp}>
                <button type="submit" className={PRIMARY_ACTION} disabled={busy}>
                  {busy ? <AuthSpinner /> : <FiMail className="h-4 w-4" aria-hidden="true" />}
                  {busy ? 'Sending…' : 'Send reset link'}
                </button>
              </motion.div>
            </form>
          </>
        )}

        {sent && (
          <div className="mt-6 flex flex-col gap-4">
            <p role="status" className="text-sm leading-6 text-tp-steel">
              The link works once and expires. If nothing arrives, check spam or request a new link.
            </p>
            <button type="button" className={SECONDARY_ACTION} onClick={() => setDelivery(null)}>
              Send another link
            </button>
          </div>
        )}

        <Link
          className={`mt-6 text-center text-sm ${TEXT_LINK}`}
          to="/authentication"
          viewTransition
        >
          Back to log in
        </Link>
      </div>
    </AuthLayout>
  );
}
