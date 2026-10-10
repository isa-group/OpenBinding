import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, TriangleAlert } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../../components/InstitutionMark/institution';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { leaveTo } from '../../utils/navigation';
import { useResource } from '../../utils/useResource';
import { classifyAuthError } from './accountErrors';
import { AccountLayout, PermissionNotice } from './AccountLayout';
import { DeleteAccountDialog, EmailForm, PasswordForm } from './ProfileForms';

/** Profile & security (`acct-profile`, `/app/account`). */
export function Account() {
  const { user, refresh, signOut } = useAuth();
  const navigate = useNavigate();
  const institutional = useInstitutionalBranding();
  // Only the "contract pending" flag is read from usage here; a failure there leaves it out rather than fail the page.
  const usage = useResource(`profile-usage:${user?.id ?? ''}`, () => apiClient.getOwnUsage());
  const [toast, setToast] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  if (!user) return null;

  const flash = (message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  // A new email or password can change what the account is (and, with it, the institutional mark): re-read the profile.
  const saved = async (message: string) => {
    await refresh();
    flash(message);
  };

  const logOut = async () => {
    setLoggingOut(true);
    setLogoutError(undefined);
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch {
      // The session is gone locally either way; the server could not be told.
      setLoggingOut(false);
      setLogoutError('The server couldn’t be told, but this browser no longer holds your session. Reload the page.');
    }
  };

  const reload = async () => {
    setRefreshing(true);
    usage.reload();
    await refresh();
    setRefreshing(false);
  };

  const pending = usage.data?.contract_pending === true;
  const forbidden = usage.status === 'error' && classifyAuthError(usage.error).status === 403;

  return (
    <AccountLayout
      section="profile"
      title="Account"
      lede="Your profile, sign-in details and account security."
      actions={<Action variant="secondary" size="sm" onClick={() => void reload()} busy={refreshing}>Refresh profile</Action>}
    >
      {forbidden && <PermissionNotice permissions={['account:read', 'account:write']} action="change account settings" />}
      {toast && (
        <div className="acct-toast" role="status"><Check aria-hidden="true" />{toast}</div>
      )}

      <section className="acct-section" aria-labelledby="acct-profile-title">
        <div>
          <h2 id="acct-profile-title">Profile</h2>
          <p className="acct-muted">How OpenBinding knows you. Role and plan are separate: the plan sets quotas, the role sets platform permissions.</p>
        </div>
        <div className="acct-card acct-profile">
          <span className="acct-avatar" aria-hidden="true">{user.username.slice(0, 2).toUpperCase()}</span>
          <div className="acct-profile-who">
            <strong>{user.username}</strong>
            <span>{user.email} · member since {formatDate(user.created_at) ?? '—'}</span>
          </div>
          <div className="acct-chips">
            <Chip>Role · {user.role}</Chip>
            <Chip tone="accent">Plan · {user.plan}</Chip>
            {institutional && <span className="acct-us-pill">{INSTITUTION_NAME} · verified</span>}
            {pending && <Chip tone="warning">Contract pending</Chip>}
          </div>
          <p className="acct-profile-note">
            Plan tiers and quotas are governed by administrators; there is no payment gateway.{' '}
            <Link to="/app/account/usage" viewTransition>See your usage &amp; plan</Link>.
          </p>
        </div>
      </section>

      <section className="acct-section" aria-labelledby="acct-email-title">
        <div>
          <h2 id="acct-email-title">Email</h2>
          <p className="acct-muted">Used to log in and for contract notices.</p>
        </div>
        <EmailForm user={user} onSaved={saved} />
      </section>

      <section className="acct-section" aria-labelledby="acct-password-title">
        <div>
          <h2 id="acct-password-title">Password</h2>
          <p className="acct-muted">Changing it needs your current password.</p>
        </div>
        <PasswordForm onSaved={saved} />
      </section>

      <section className="acct-section" aria-labelledby="acct-sessions-title">
        <div>
          <h2 id="acct-sessions-title">Sessions</h2>
          <p className="acct-muted">Logging out revokes this browser’s refresh token.</p>
        </div>
        <div className="acct-card acct-row">
          <span>This browser</span>
          <Action variant="secondary" onClick={() => void logOut()} busy={loggingOut}>Log out</Action>
        </div>
        {logoutError && <p className="acct-dialog-error" role="alert">{logoutError}</p>}
      </section>

      <section className="acct-section" aria-labelledby="acct-danger-title">
        <h2 id="acct-danger-title">Danger zone</h2>
        <div className="acct-card acct-danger">
          <div className="acct-danger-head">
            <span className="acct-danger-icon" aria-hidden="true"><TriangleAlert /></span>
            <div>
              <strong>Delete account</strong>
              <p>Permanently deletes your account, its API keys and its jobs. Organizations where you’re the last owner must be handed over first.</p>
            </div>
          </div>
          <Action variant="danger-outline" className="acct-danger-button" onClick={() => setDeleting(true)}>Delete my account</Action>
        </div>
      </section>

      {deleting && (
        <DeleteAccountDialog
          user={user}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            // The account no longer exists; nothing to revoke. Leave with a clean browser.
            apiClient.clearTokens();
            leaveTo('/');
          }}
        />
      )}
    </AccountLayout>
  );
}
