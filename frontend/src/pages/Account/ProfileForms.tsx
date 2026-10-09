import { useRef, useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { apiClient } from '../../api/client';
import type { UserProfile } from '../../api/auth';
import { Action } from '../../components/ui/Action';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { MIN_PASSWORD_LENGTH } from '../Auth/passwordStrength';
import { classifyAuthError, fallbackMessage, marker } from './accountErrors';

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WRONG_PASSWORD = 'That isn’t your current password (401 · invalid_credentials).';

interface FormProps {
  user: UserProfile;
  onSaved: (message: string) => Promise<void> | void;
}

/** Change the sign-in email. The gateway treats it as a credential, so it asks for the current password. */
export function EmailForm({ user, onSaved }: FormProps) {
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const value = email ?? user.email;
  const dirty = value.trim().toLowerCase() !== user.email.toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setEmailError(undefined);
    setPasswordError(undefined);
    if (!EMAIL_PATTERN.test(value.trim())) {
      setEmailError('Enter a valid email address.');
      emailRef.current?.focus();
      return;
    }
    if (!password) {
      setPasswordError('Enter your current password to change your email.');
      passwordRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await apiClient.updateOwnProfile({ email: value.trim(), current_password: password });
      setPassword('');
      setEmail(null);
      await onSaved(`Email updated to ${value.trim()}.`);
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'conflict') setEmailError('That email is already used by another account (409 · already_registered).');
      else if (failure.kind === 'rejected') { setPasswordError(WRONG_PASSWORD); passwordRef.current?.focus(); }
      else if (failure.kind === 'invalid') setEmailError(failure.message || 'That email isn’t acceptable.');
      else setEmailError(fallbackMessage(failure, 'changed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="acct-card acct-form" onSubmit={submit} noValidate>
      <div className="acct-form-grid">
        <FormField
          label="Email address"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(event) => { setEmail(event.target.value); setEmailError(undefined); }}
          error={emailError}
          inputRef={emailRef}
        />
        <FormField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setPasswordError(undefined); }}
          error={passwordError}
          hint="Needed because the email is one of the ways you log in."
          inputRef={passwordRef}
        />
      </div>
      <div className="acct-form-actions">
        <Action type="submit" variant="primary" disabled={!dirty} busy={busy}>Save changes</Action>
        {dirty && <span className="acct-muted">You have unsaved changes</span>}
      </div>
    </form>
  );
}

/** Change the password: the current one, a new one of at least 10 characters, typed twice. */
export function PasswordForm({ onSaved }: Pick<FormProps, 'onSaved'>) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [currentError, setCurrentError] = useState<string>();
  const [nextError, setNextError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const long = next.length >= MIN_PASSWORD_LENGTH;
  const mismatch = confirm !== '' && confirm !== next;
  const help = !next
    ? `At least ${MIN_PASSWORD_LENGTH} characters`
    : long ? `✓ At least ${MIN_PASSWORD_LENGTH} characters`
      : `${MIN_PASSWORD_LENGTH - next.length} more ${MIN_PASSWORD_LENGTH - next.length === 1 ? 'character' : 'characters'} needed`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setCurrentError(undefined);
    setNextError(undefined);
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
    setBusy(true);
    try {
      await apiClient.updateOwnProfile({ current_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setTouched(false);
      await onSaved('Password changed.');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'rejected') { setCurrentError(WRONG_PASSWORD); currentRef.current?.focus(); }
      else if (failure.kind === 'invalid') { setNextError(failure.message || 'That password isn’t acceptable. Try a longer one.'); nextRef.current?.focus(); }
      else setNextError(fallbackMessage(failure, 'changed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="acct-card acct-form" onSubmit={submit} noValidate>
      <div className="acct-form-grid is-three">
        <FormField
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => { setCurrent(event.target.value); setCurrentError(undefined); }}
          error={currentError}
          inputRef={currentRef}
        />
        <FormField
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => { setNext(event.target.value); setNextError(undefined); }}
          error={nextError ?? (touched && next && !long ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` : undefined)}
          hint={help}
          hintTone={next && long ? 'ok' : 'neutral'}
          inputRef={nextRef}
        />
        <FormField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={mismatch && touched ? 'New password and confirm password do not match.' : undefined}
          hint="Type it again."
          inputRef={confirmRef}
        />
      </div>
      <div className="acct-form-actions">
        <Action type="submit" variant="primary" busy={busy}>Change password</Action>
      </div>
    </form>
  );
}

/** What the gateway's refusals to delete an account mean, in terms of what the person must do first. */
function deletionRefusal(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'last_owner':
      return 'You’re the last owner of an organization (409 · last_owner). Make someone else an owner, or delete the organization, first.';
    case 'organization_owner_required':
      return 'Some of your shared work belongs to an organization with no other owner (409 · organization_owner_required). Make someone else an owner first.';
    case 'sponsor_transfer_required':
      return 'You sponsor an organization that has no other owner to take over (409 · sponsor_transfer_required). Transfer sponsorship first.';
    case 'last_pricing_admin':
      return 'You’re the last pricing administrator (409 · last_pricing_admin). Another admin must exist before this account can go.';
    default:
      return fallback;
  }
}

/** Typed confirmation for deleting the account. Nothing is requested until the username has been typed exactly. */
export function DeleteAccountDialog({ user, onClose, onDeleted }: { user: UserProfile; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const matches = typed === user.username;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!matches) {
      setError(`The text doesn’t match your username (422 · confirmation_mismatch).`);
      return;
    }
    setBusy(true);
    setError(undefined);
    setPasswordError(undefined);
    try {
      await apiClient.deleteOwnAccount(typed, password);
      onDeleted();
    } catch (caught) {
      const failure = classifyAuthError(caught);
      if (failure.kind === 'rejected') setPasswordError(WRONG_PASSWORD);
      else if (failure.kind === 'invalid') setError('The text doesn’t match your username (422 · confirmation_mismatch).');
      else if (failure.kind === 'conflict') setError(deletionRefusal(failure.code, `${failure.message}${marker(failure)}`));
      else setError(fallbackMessage(failure, 'deleted'));
      setBusy(false);
    }
  };

  return (
    <Modal title="Confirm deletion" tone="danger" size="sm" onClose={onClose}>
      <form className="acct-dialog-form" onSubmit={submit} noValidate>
        <p>This can’t be undone.</p>
        <FormField
          label={`Type ${user.username} to confirm`}
          value={typed}
          onChange={(event) => { setTyped(event.target.value); setError(undefined); }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <FormField
          label="Current password (if your account has one)"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => { setPassword(event.target.value); setPasswordError(undefined); }}
          error={passwordError}
        />
        <div aria-live="assertive">
          {error && <div className="acct-dialog-error" role="alert"><TriangleAlert aria-hidden="true" />{error}</div>}
        </div>
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose}>Cancel</Action>
          <Action type="submit" variant="danger" disabled={!matches} busy={busy}>Delete account</Action>
        </div>
      </form>
    </Modal>
  );
}
