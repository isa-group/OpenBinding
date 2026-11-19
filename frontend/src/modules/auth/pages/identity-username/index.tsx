// Adapted from SPACE frontend/src/pages/sphere-auth/index.tsx (revision 3d35281), https://github.com/SCORELabUS/space.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's first SCORETech sign-in only (no linking of an existing account, which OpenBinding never does): the
// pending sign-up and its suggestion from `GET /v1/auth/identity/pending`, the chosen username sent to
// `POST /v1/auth/identity/complete`, each refusal named under the field; "Use another account" ends the pending sign-up and its
// SCORETech session; SPHERE's split auth layout and OpenBinding's form pieces.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { HttpError } from '../../../core/api/http';
import { AuthField } from '../../components/auth-field';
import AuthLayout from '../../components/auth-layout';
import { identityApi, type PendingSignUp } from '../../api/identityApi';
import { useAuth } from '../../hooks/useAuth';
import { safeReturnPath } from '../../utils/authFlow';
import { LEDE, PRIMARY_ACTION, SECONDARY_ACTION, TITLE } from '../../utils/classes';

/** The gateway's username rule (`USERNAME_PATTERN`): 3 to 64 characters, starting with a letter or digit. */
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;

/** What each refusal of `complete` means, under the field. */
const REFUSALS: Record<string, string> = {
  username_taken: 'That username is taken. Choose another one.',
  username_unavailable: 'That username is reserved. Choose another one.',
  pending_in_progress:
    'This sign-in is already being completed in another tab. Wait a moment and try again.',
  account_not_linked:
    'An OpenBinding account that isn’t linked to SCORETech Identity already uses your verified email. Ask an administrator to help you.',
  identity_already_provisioned:
    'Your SCORETech account already has an OpenBinding account. Sign in again to use it.',
  validation_error:
    'Use 3 to 64 letters, digits, dots, hyphens or underscores, starting with a letter or digit.',
};

function complaintFor(username: string): string | null {
  if (!username) return 'Choose a username.';
  if (!USERNAME.test(username)) return REFUSALS.validation_error;
  return null;
}

/** `/sso/identity/username`: the first SCORETech sign-in chooses the public name of its OpenBinding account. */
export default function IdentityUsernamePage() {
  const { resume, signOut } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = safeReturnPath(params.get('returnTo')) ?? '/';
  const [pending, setPending] = useState<PendingSignUp | null>(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    identityApi
      .identityPending()
      .then(value => {
        if (!active) return;
        setPending(value);
        setUsername(value.suggested_username);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        // Nothing is waiting: it expired (15 minutes), was completed in another tab, or never existed.
        if (caught instanceof HttpError && caught.status === 404)
          navigate('/authentication?identity_error=expired', { replace: true });
        else setFailure('We couldn’t read your sign-in. Try again in a moment.');
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const complaint = complaintFor(username.trim());
    setError(complaint);
    if (complaint) {
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const done = await identityApi.identityComplete(username.trim());
      await resume();
      navigate(safeReturnPath(done.return_to) ?? returnTo, { replace: true });
    } catch (caught) {
      setBusy(false);
      if (caught instanceof HttpError && caught.status === 404) {
        navigate('/authentication?identity_error=expired', { replace: true });
        return;
      }
      const code = caught instanceof HttpError ? caught.code : undefined;
      if (code && code in REFUSALS) {
        setError(REFUSALS[code]);
        inputRef.current?.focus();
      } else
        setFailure('We couldn’t create your account right now. Nothing was created; try again.');
    }
  };

  const anotherAccount = async () => {
    setBusy(true);
    await signOut().catch(() => undefined);
    navigate('/', { replace: true });
  };

  return (
    <AuthLayout>
      <Helmet>
        <title>OpenBinding - Choose your username</title>
      </Helmet>
      <div className="flex flex-col">
        <h1 className={TITLE}>Choose your username</h1>
        <p className={LEDE}>
          {pending?.display_name ? `Welcome, ${pending.display_name}. ` : 'Welcome. '}
          This is your first time in OpenBinding with your SCORETech account.
          {pending?.email ? (
            <>
              {' '}
              You’re signing in as <strong className="text-tp-ink">{pending.email}</strong>.
            </>
          ) : null}
        </p>
        {failure && (
          <p
            role="alert"
            className="mt-5 rounded-lg border border-tp-hairline p-3 text-sm text-tp-ink"
          >
            {failure}
          </p>
        )}
        {!pending && !failure && (
          <p role="status" className="mt-5 text-sm text-tp-steel">
            Checking your sign-in…
          </p>
        )}
        {pending && (
          <form className="mt-7 flex flex-col gap-4" onSubmit={submit} noValidate>
            <AuthField
              id="identity-username"
              name="username"
              label="Username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={event => setUsername(event.target.value)}
              disabled={busy}
              error={error ?? undefined}
              hint="Your username is public: it names your compositions, engines and organizations."
              inputRef={inputRef}
            />
            <button type="submit" className={PRIMARY_ACTION} disabled={busy}>
              {busy ? 'Creating your account…' : 'Create my account'}
            </button>
          </form>
        )}
        <button
          type="button"
          className={`mt-4 ${SECONDARY_ACTION}`}
          onClick={() => void anotherAccount()}
          disabled={busy}
        >
          Not you? Use another account
        </button>
      </div>
    </AuthLayout>
  );
}
