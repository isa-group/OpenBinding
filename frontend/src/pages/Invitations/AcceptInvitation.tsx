import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check } from 'lucide-react';
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { QuotaError } from '../../api/auth';
import { platformApi } from '../../api/platform';
import type { Organization, OrganizationMember, OrganizationRole } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { classifyAuthError } from '../Auth/authErrors';
import './AcceptInvitation.css';

/** The gateway rejects shorter tokens before looking anything up. */
const MIN_TOKEN_LENGTH = 32;
const PATH = '/invitations/accept';

const ROLE_COPY: Record<OrganizationRole, string> = {
  OWNER: 'As an owner you manage the organization, its members and its settings.',
  ADMIN: 'As an admin you can manage members and settings. Owners can change your role later.',
  MEMBER: 'As a member you can create projects and cases. Sub-organizations inherit your role unless they grant you a higher one. Admins can change your role later.',
  VIEWER: 'As a viewer you can read what the organization shares with you. Admins can change your role later.',
};

type Failure =
  | { kind: 'refused' }
  | { kind: 'sponsor'; limit?: number }
  | { kind: 'malformed' }
  | { kind: 'unavailable' }
  | { kind: 'network' }
  | { kind: 'unknown' };

interface Joined {
  member: OrganizationMember;
  organization: Organization | null;
  alreadyMember: boolean;
}

interface InviteState {
  token?: string;
}

const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';

/**
 * Accept an organization invitation with the token that came in the link (or was pasted).
 *
 * The API has no preview: the organization and the role are known only after accepting, and every refusal of
 * a token (invalid, expired, used, sent to another email) is the same 404, so they are reported together.
 */
export function AcceptInvitation() {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  // Present when the screen is inside the application layout, so the header's organization list can be refreshed.
  const platform = useOutletContext<PlatformOutletContext | undefined>();
  const queryToken = new URLSearchParams(location.search).get('token');
  const keptToken = (location.state as InviteState | null)?.token;
  const [token, setToken] = useState(() => (queryToken ?? keptToken ?? '').trim());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [joined, setJoined] = useState<Joined | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hadLinkToken = Boolean(queryToken ?? keptToken);

  useEffect(() => {
    // A secret does not stay in the address bar, the history list or the Referer of an outgoing link:
    // it moves to this entry's own state, which survives a reload and goes nowhere else.
    if (queryToken) navigate(PATH, { replace: true, state: { token: queryToken.trim() } satisfies InviteState });
  }, [queryToken, navigate]);

  const trimmed = token.trim();
  const tokenError = touched && !trimmed
    ? 'Paste the invitation token.'
    : (touched && trimmed.length < MIN_TOKEN_LENGTH) || failure?.kind === 'malformed'
      ? `That doesn’t look like an invitation token: they are at least ${MIN_TOKEN_LENGTH} characters long.`
      : undefined;
  // Sent to log in and back: the return address carries the token (in router state, never in a visible URL),
  // and this page moves it out of the query again as soon as it is back.
  const loginState = { from: trimmed ? `${PATH}?token=${encodeURIComponent(trimmed)}` : PATH };

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    if (trimmed.length < MIN_TOKEN_LENGTH) {
      setTouched(true);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      // Memberships before, to tell a fresh join from an invitation to somewhere the account already belongs.
      const before = await platformApi.organizations().catch(() => null);
      const member = await platformApi.acceptInvitation(trimmed);
      const after = await platformApi.organizations().catch(() => null);
      setJoined({
        member,
        organization: after?.find((item) => item.id === member.organization_id) ?? null,
        alreadyMember: Boolean(before?.some((item) => item.id === member.organization_id)),
      });
      setToken('');
      void platform?.reload();
    } catch (caught) {
      const result = classifyAuthError(caught);
      if (caught instanceof QuotaError || result.kind === 'quota') {
        setFailure({ kind: 'sponsor', limit: caught instanceof QuotaError ? caught.quota?.limit : undefined });
      } else if (result.kind === 'not-found') {
        setFailure({ kind: 'refused' });
      } else if (result.kind === 'invalid') {
        setFailure({ kind: 'malformed' });
        inputRef.current?.focus();
      } else if (result.kind === 'unavailable') {
        setFailure({ kind: 'unavailable' });
      } else if (result.kind === 'network') {
        setFailure({ kind: 'network' });
      } else {
        setFailure({ kind: 'unknown' });
      }
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="invite-page" aria-busy="true">
        <Skeleton variant="panel" />
      </div>
    );
  }

  if (joined) {
    const { member, organization, alreadyMember } = joined;
    const name = organization?.name ?? 'the organization';
    return (
      <div className="invite-page">
        <div className="invite-card">
          <span className="invite-eyebrow">Organization invitation</span>
          <div className="invite-done" role="status">
            <span className="invite-check" aria-hidden="true"><Check /></span>
            <h1>{alreadyMember ? `You’re already a member of ${name}` : `You joined ${name}`}</h1>
          </div>
          {alreadyMember && <Notice tone="info">Nothing changed: your current role stays as it is.</Notice>}
          <div className="invite-org">
            <span className="invite-org-mark" aria-hidden="true">{initialsOf(organization?.name ?? 'Organization')}</span>
            <div className="invite-org-name">
              <strong>{organization?.name ?? 'Organization'}</strong>
              {organization && <code>@{organization.slug}</code>}
            </div>
            <Chip>{member.role}</Chip>
          </div>
          <p className="invite-note">{ROLE_COPY[member.role]}</p>
          <Link className="invite-btn invite-btn-primary" to={organization ? `/app/${organization.slug}` : '/app'} viewTransition>
            Open the organization
          </Link>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="invite-page">
        <div className="invite-card">
          <span className="invite-eyebrow">Organization invitation</span>
          <h1>Log in to accept</h1>
          <p className="invite-note">
            Invitations are accepted from a signed-in account. Your invitation link is kept, so you’ll come back here after logging in.
          </p>
          <div className="invite-actions">
            <Link className="invite-btn invite-btn-primary" to="/login" state={loginState} viewTransition>Log in</Link>
            <Link className="invite-btn invite-btn-secondary" to="/register" state={loginState} viewTransition>Create an account</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="invite-page">
      <div className="invite-card">
        <span className="invite-eyebrow">Organization invitation</span>
        <h1>{hadLinkToken || trimmed ? 'Join with this invitation' : 'Paste your invitation'}</h1>
        <p className="invite-note">
          {hadLinkToken || trimmed
            ? `Signed in as ${user.username}. Accept to join the organization with the role you were invited to.`
            : 'Opened this page without a link? Paste the token you were sent. It’s shown once to the person who invited you.'}
        </p>
        <Notice tone="info">
          The organization and role are confirmed once you accept: the API has no endpoint to preview an invitation before using it.
        </Notice>

        <form className="invite-form" onSubmit={accept} noValidate>
          <div className="invite-field">
            <label htmlFor="invitation-token">Invitation token</label>
            <input
              ref={inputRef}
              id="invitation-token"
              name="token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Paste the token you received"
              disabled={busy}
              aria-invalid={tokenError ? true : undefined}
              aria-describedby={tokenError ? 'invitation-token-help invitation-token-error' : 'invitation-token-help'}
            />
            {tokenError && <span id="invitation-token-error" className="invite-error">{tokenError}</span>}
            <span id="invitation-token-help" className="invite-help">Tokens are valid for 7 days and work once.</span>
          </div>

          <div aria-live="assertive" className="invite-results">
            {failure?.kind === 'refused' && (
              <Notice tone="error" title="This invitation can’t be used.">
                It’s invalid, expired or was already used, or it was sent to a different email address than {user.email}: the gateway
                doesn’t say which. Log in with the account that received it, or ask the person who invited you for a new one.{' '}
                <button type="button" className="invite-inline" onClick={() => void signOut()}>Log out</button>
              </Notice>
            )}
            {failure?.kind === 'sponsor' && (
              <Notice tone="error" title="The organization can’t add more members right now (402 · sponsor_quota_exceeded).">
                Its sponsor has reached the unique-member limit of their plan{failure.limit !== undefined ? ` (${failure.limit.toLocaleString('en-US')})` : ''}.
                Let the inviter know; your invitation stays valid until it expires.
              </Notice>
            )}
            {failure?.kind === 'unavailable' && (
              <Notice tone="error" title="Invitations are unavailable right now (503).">
                Nothing was changed. Try again in a moment. <Link to="/status">Service status</Link>
              </Notice>
            )}
            {failure?.kind === 'network' && (
              <Notice tone="error" title="OpenBinding couldn’t be reached.">Nothing was changed. Check your connection and try again.</Notice>
            )}
            {failure?.kind === 'unknown' && (
              <Notice tone="error" title="The invitation could not be accepted.">Nothing was changed. Try again in a moment.</Notice>
            )}
          </div>

          <button type="submit" className="invite-btn invite-btn-primary" disabled={busy}>
            {busy && <span className="invite-spinner" aria-hidden="true" />}
            {busy ? 'Accepting…' : 'Accept invitation'}
          </button>
          <Link className="invite-link" to="/app" viewTransition>Not now</Link>
        </form>
      </div>
    </div>
  );
}
