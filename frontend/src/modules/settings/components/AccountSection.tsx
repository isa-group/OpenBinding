// Adapted from SPHERE frontend/src/modules/settings/components/AccountSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's account: the sign-in email and the password, each changed with the current password
// (`PATCH /v1/users/me`, the checks and refusals of OpenBinding's former ProfileForms), with SPHERE's change-password card and a
// strength meter; names and phone are not ported (OpenBinding keeps neither); failures are said, never only logged.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FiKey, FiMail, FiUser } from 'react-icons/fi';
import { formatDate } from '../../../utils/format';
import {
  INSTITUTION_NAME,
  useInstitutionalBranding,
} from '../../../components/InstitutionMark/institution';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { Chip } from '../../core/components/chip';
import { FormField } from '../../core/components/form-field';
import { useUserSettingsApi } from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';
import { MIN_PASSWORD_LENGTH, passwordStrength } from '../utils/passwordStrength';
import { useSavedFlash } from '../utils/useSavedFlash';
import SaveButton from './SaveButton';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WRONG_PASSWORD = 'That isn’t your current password (401 · invalid_credentials).';

const STRENGTH_BAR = ['bg-tp-hairline', 'bg-red-500', 'bg-amber-500', 'bg-green-600'] as const;

interface Props {
  onDirtyChange?: (dirty: boolean) => void;
}

export default function AccountSection({ onDirtyChange }: Props) {
  const { user, refresh } = useAuth();
  const api = useUserSettingsApi();
  const institutional = useInstitutionalBranding();
  const [notice, setNotice] = useState<string | null>(null);

  // Email
  const [email, setEmail] = useState<string | null>(null);
  const [emailPassword, setEmailPassword] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [emailPasswordError, setEmailPasswordError] = useState<string>();
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailSaved, flashEmail] = useSavedFlash();
  const emailRef = useRef<HTMLInputElement>(null);
  const emailPasswordRef = useRef<HTMLInputElement>(null);

  // Password
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [currentError, setCurrentError] = useState<string>();
  const [nextError, setNextError] = useState<string>();
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, flashPassword] = useSavedFlash();
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const savedEmail = user?.email ?? '';
  const emailValue = email ?? savedEmail;
  const emailDirty = emailValue.trim().toLowerCase() !== savedEmail.toLowerCase();
  const passwordDirty = current !== '' || next !== '' || confirm !== '';
  const dirty = emailDirty || passwordDirty;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  if (!user) return null;

  const long = next.length >= MIN_PASSWORD_LENGTH;
  const mismatch = confirm !== '' && confirm !== next;
  const strength = passwordStrength(next);
  const lengthHelp = !next
    ? `At least ${MIN_PASSWORD_LENGTH} characters`
    : long
      ? `✓ At least ${MIN_PASSWORD_LENGTH} characters`
      : `${MIN_PASSWORD_LENGTH - next.length} more ${MIN_PASSWORD_LENGTH - next.length === 1 ? 'character' : 'characters'} needed`;

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setEmailError(undefined);
    setEmailPasswordError(undefined);
    setNotice(null);
    const address = emailValue.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setEmailError('Enter a valid email address.');
      emailRef.current?.focus();
      return;
    }
    if (!emailPassword) {
      setEmailPasswordError('Enter your current password to change your email.');
      emailPasswordRef.current?.focus();
      return;
    }
    setSavingEmail(true);
    try {
      await api.updateProfile({ email: address, current_password: emailPassword });
      setEmailPassword('');
      setEmail(null);
      // A new email can change what the account is (and its institutional mark): re-read the profile.
      await refresh();
      flashEmail();
      setNotice(`Email updated to ${address}.`);
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'conflict')
        setEmailError('That email is already used by another account (409 · already_registered).');
      else if (failure.kind === 'rejected') {
        setEmailPasswordError(WRONG_PASSWORD);
        emailPasswordRef.current?.focus();
      } else if (failure.kind === 'invalid')
        setEmailError(failure.message || 'That email isn’t acceptable.');
      else setEmailError(fallbackMessage(failure, 'changed'));
    } finally {
      setSavingEmail(false);
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setCurrentError(undefined);
    setNextError(undefined);
    setNotice(null);
    setTouched(true);
    if (!current) {
      setCurrentError('Enter your current password.');
      currentRef.current?.focus();
      return;
    }
    if (!long) {
      setNextError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      nextRef.current?.focus();
      return;
    }
    if (next !== confirm) {
      confirmRef.current?.focus();
      return;
    }
    setSavingPassword(true);
    try {
      await api.updateProfile({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
      await refresh();
      flashPassword();
      setNotice('Password changed.');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'rejected') {
        setCurrentError(WRONG_PASSWORD);
        currentRef.current?.focus();
      } else if (failure.kind === 'invalid') {
        setNextError(failure.message || 'That password isn’t acceptable. Try a longer one.');
        nextRef.current?.focus();
      } else setNextError(fallbackMessage(failure, 'changed'));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-tp-ink">Account Details</h2>
        <p className="mt-0.5 text-sm text-tp-steel">
          Your sign-in email and password. Both changes need your current password.
        </p>
      </div>

      <BlockAlert variant="success" message={notice} onDismiss={() => setNotice(null)} />

      <div className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-tp-primary/10">
            <FiUser className="h-6 w-6 text-tp-accent" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-all text-tp-ink">{user.username}</p>
            <p className="mt-0.5 text-xs break-all text-tp-steel">
              {user.email} · member since {formatDate(user.created_at) ?? '—'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip>Role · {user.role}</Chip>
              <Chip tone="accent">Plan · {user.plan}</Chip>
              {institutional && <Chip tone="success">{INSTITUTION_NAME} · verified</Chip>}
            </div>
          </div>
        </div>
      </div>

      <form
        onSubmit={submitEmail}
        noValidate
        aria-labelledby="settings-email-title"
        className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6"
      >
        <div className="mb-5 flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-tp-primary/10">
            <FiMail className="h-5 w-5 text-tp-accent" aria-hidden="true" />
          </div>
          <div>
            <h3 id="settings-email-title" className="text-sm font-medium text-tp-ink">
              Email
            </h3>
            <p className="mt-1 text-xs text-tp-steel">Used to sign in and for contract notices.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Email address"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={emailValue}
            onChange={event => {
              setEmail(event.target.value);
              setEmailError(undefined);
            }}
            error={emailError}
            inputRef={emailRef}
          />
          <FormField
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={emailPassword}
            onChange={event => {
              setEmailPassword(event.target.value);
              setEmailPasswordError(undefined);
            }}
            error={emailPasswordError}
            hint="Needed because the email is one of the ways you sign in."
            inputRef={emailPasswordRef}
          />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SaveButton
            type="submit"
            saving={savingEmail}
            saved={emailSaved}
            disabled={!emailDirty}
            label="Save email"
          />
          {emailDirty && !emailSaved && (
            <span className="text-xs text-tp-steel">You have unsaved changes</span>
          )}
        </div>
      </form>

      <form
        onSubmit={submitPassword}
        noValidate
        aria-labelledby="settings-password-title"
        className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6"
      >
        <div className="mb-5 flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-tp-primary/10">
            <FiKey className="h-5 w-5 text-tp-accent" aria-hidden="true" />
          </div>
          <div>
            <h3 id="settings-password-title" className="text-sm font-medium text-tp-ink">
              Password
            </h3>
            <p className="mt-1 text-xs text-tp-steel">Changing it needs your current password.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <FormField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={event => {
                setCurrent(event.target.value);
                setCurrentError(undefined);
              }}
              error={currentError}
              inputRef={currentRef}
            />
          </div>
          <div className="flex flex-col gap-2">
            <FormField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={event => {
                setNext(event.target.value);
                setNextError(undefined);
              }}
              error={
                nextError ??
                (touched && next && !long
                  ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`
                  : undefined)
              }
              hint={lengthHelp}
              hintTone={next && long ? 'ok' : 'neutral'}
              inputRef={nextRef}
            />
            {next && (
              <div className="flex items-center gap-2" aria-live="polite">
                <div className="flex flex-1 gap-1" aria-hidden="true">
                  {[1, 2, 3].map(step => (
                    <span
                      key={step}
                      className={`h-1 flex-1 rounded-full ${
                        strength.level >= step ? STRENGTH_BAR[strength.level] : STRENGTH_BAR[0]
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xs text-tp-steel">Strength: {strength.label}</span>
              </div>
            )}
          </div>
          <FormField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={event => setConfirm(event.target.value)}
            error={
              mismatch && touched ? 'New password and confirm password do not match.' : undefined
            }
            hint="Type it again."
            inputRef={confirmRef}
          />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <SaveButton
            type="submit"
            saving={savingPassword}
            saved={passwordSaved}
            disabled={!passwordDirty}
            label="Change password"
          />
        </div>
      </form>
    </div>
  );
}
