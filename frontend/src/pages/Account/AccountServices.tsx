import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Bell, Building2, KeyRound, Mail, ShieldCheck, Trash2 } from 'lucide-react';
import { apiClient } from '../../api/client';
import type {
  ExternalIdentity,
  Notification,
  NotificationPreferences,
  UserProfile,
} from '../../api/auth';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';

const DEFAULT_PREFERENCES: NotificationPreferences = {
  inbox: true,
  email_contract_changes: true,
  email_invitations: true,
  email_job_failures: false,
};

export function AccountServices({ user, refresh }: { user: UserProfile; refresh: () => Promise<void> }) {
  const [identities, setIdentities] = useState<ExternalIdentity[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [identityResult, notificationResult, preferenceResult] = await Promise.allSettled([
      apiClient.listOwnIdentities(),
      apiClient.listNotifications(),
      apiClient.getNotificationPreferences(),
    ]);
    if (identityResult.status === 'fulfilled') setIdentities(identityResult.value);
    if (notificationResult.status === 'fulfilled') setNotifications(notificationResult.value);
    if (preferenceResult.status === 'fulfilled') setPreferences(preferenceResult.value);
    if ([identityResult, notificationResult, preferenceResult].some((result) => result.status === 'rejected')) {
      setError('Some account services could not be loaded. Your profile and API keys still work.');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim();
    const currentPassword = String(form.get('currentPassword') || '');
    const newPassword = String(form.get('newPassword') || '');
    setBusy('profile'); setError(null); setNotice(null);
    try {
      await apiClient.updateOwnProfile({
        ...(email && email !== user.email ? { email } : {}),
        ...(newPassword ? { new_password: newPassword } : {}),
        current_password: currentPassword,
      });
      event.currentTarget.reset();
      await refresh();
      setNotice('Account credentials updated.');
    } catch {
      setError('Credentials were not changed. Check the current password and the new values.');
    } finally { setBusy(null); }
  };

  const beginCasLink = async () => {
    setBusy('cas'); setError(null);
    try {
      window.location.assign(await apiClient.createCasLinkIntent());
    } catch {
      setBusy(null);
      setError('Institutional linking is unavailable. Your current sign-in method is unchanged.');
    }
  };

  const unlink = async (identity: ExternalIdentity, confirmation: string) => {
    setBusy(identity.id); setError(null); setNotice(null);
    try {
      await apiClient.unlinkOwnIdentity(identity.id, confirmation || undefined);
      setUnlinking(null);
      await Promise.all([load(), refresh()]);
      setNotice(user.plan === 'RESEARCH'
        ? 'Institutional access removed. The account now uses the free plan.'
        : 'Institutional identity removed.');
    } catch {
      setError('That identity could not be removed. Keep at least one working sign-in method.');
    } finally { setBusy(null); }
  };

  const savePreferences = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy('preferences'); setError(null); setNotice(null);
    try {
      setPreferences(await apiClient.updateNotificationPreferences(preferences));
      setNotice('Notification preferences saved.');
    } catch { setError('Notification preferences could not be saved.'); }
    finally { setBusy(null); }
  };

  const markRead = async (notification: Notification) => {
    if (notification.read_at) return;
    setBusy(notification.id);
    try {
      const read = await apiClient.markNotificationRead(notification.id);
      setNotifications((current) => current.map((item) => item.id === read.id ? read : item));
    } catch { setError('That notification could not be marked as read.'); }
    finally { setBusy(null); }
  };

  const deleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const confirmation = String(form.get('confirmation') || '');
    if (confirmation !== user.username) {
      setError(`Type ${user.username} exactly to delete this account.`);
      return;
    }
    setBusy('delete'); setError(null);
    try {
      await apiClient.deleteOwnAccount(confirmation, String(form.get('deletePassword') || ''));
      apiClient.clearTokens();
      window.location.assign('/');
    } catch {
      setError('The account was not deleted. Check the confirmation and current password.');
      setBusy(null);
    }
  };

  const unread = notifications.filter((item) => !item.read_at).length;
  const usIdentity = identities.find((item) => item.provider === 'us-cas');

  return <section className="account-services" aria-labelledby="account-services-heading">
    <div className="account-section-heading">
      <div><span>Identity & signals</span><h2 id="account-services-heading">Account services</h2></div>
      <small>{loading ? 'Synchronising…' : `${identities.length} sign-in identities · ${unread} unread`}</small>
    </div>
    {error && <Alert type="error">{error}</Alert>}
    {notice && <Alert type="success">{notice}</Alert>}

    <div className="account-service-grid">
      <Card padding="lg" className="account-security-card">
        <header><KeyRound aria-hidden="true" /><div><span>Credentials</span><h3>Email & password</h3></div></header>
        <form onSubmit={saveProfile}>
          <label>Email<input name="email" type="email" autoComplete="email" defaultValue={user.email} /></label>
          <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label>New password <small>Leave blank to keep it</small><input name="newPassword" type="password" minLength={10} autoComplete="new-password" /></label>
          <Button type="submit" size="sm" disabled={busy === 'profile'}>{busy === 'profile' ? 'Saving…' : 'Save credentials'}</Button>
        </form>
      </Card>

      <Card padding="lg" className="account-institution-card">
        <header><Building2 aria-hidden="true" /><div><span>SSO · US</span><h3>Universidad de Sevilla</h3></div></header>
        {usIdentity ? <>
          <div className="institution-status"><ShieldCheck aria-hidden="true" /><div><strong>Verified institutional account</strong><code>{usIdentity.subject}</code></div><Badge variant="success">linked</Badge></div>
          <p>{user.plan === 'RESEARCH' ? 'Your verified UVUS identity provides the RESEARCH contract and compact US co-branding.' : 'This identity is verified; your existing non-RESEARCH contract is unchanged.'}</p>
          {unlinking === usIdentity.id ? <form className="identity-unlink" onSubmit={(event) => {
            event.preventDefault();
            void unlink(usIdentity, String(new FormData(event.currentTarget).get('confirmation') || ''));
          }}>
            {user.plan === 'RESEARCH' && <label>Type DOWNGRADE RESEARCH<input name="confirmation" required pattern="DOWNGRADE RESEARCH" autoComplete="off" /></label>}
            <div><Button type="button" size="sm" variant="ghost" onClick={() => setUnlinking(null)}>Keep identity</Button><Button type="submit" size="sm" variant="secondary" disabled={busy === usIdentity.id}>Unlink</Button></div>
          </form> : <Button size="sm" variant="ghost" onClick={() => setUnlinking(usIdentity.id)}>Unlink identity</Button>}
        </> : <>
          <p>Link a UVUS identity without merging accounts by email. The free plan becomes RESEARCH immediately; any other contract is left unchanged.</p>
          <Button size="sm" variant="secondary" onClick={() => void beginCasLink()} disabled={busy === 'cas'}>{busy === 'cas' ? 'Preparing…' : 'Link institutional identity'}</Button>
        </>}
      </Card>

      <Card padding="lg" className="account-notification-card">
        <header><Bell aria-hidden="true" /><div><span>Inbox</span><h3>Notifications</h3></div>{unread > 0 && <Badge variant="accent">{unread} new</Badge>}</header>
        <div className="notification-ledger">
          {notifications.slice(0, 8).map((notification) => <article key={notification.id} className={notification.read_at ? '' : 'is-unread'}>
            <button type="button" onClick={() => void markRead(notification)} disabled={Boolean(notification.read_at) || busy === notification.id} aria-label={notification.read_at ? `${notification.subject}, read` : `Mark ${notification.subject} as read`}>
              <span aria-hidden="true" />
              <div><strong>{notification.subject}</strong><p>{notification.body}</p><small>{new Date(notification.created_at).toLocaleString()}</small></div>
            </button>
          </article>)}
          {!notifications.length && !loading && <p className="account-empty">No notifications. Contract changes, invitations and failed jobs can appear here.</p>}
        </div>
        <form className="notification-preferences" onSubmit={savePreferences}>
          <strong><Mail aria-hidden="true" /> Delivery preferences</strong>
          {([
            ['inbox', 'Keep the account inbox'],
            ['email_contract_changes', 'Email contract changes'],
            ['email_invitations', 'Email invitations'],
            ['email_job_failures', 'Email failed jobs'],
          ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => setPreferences((current) => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}
          <Button type="submit" size="sm" variant="secondary" disabled={busy === 'preferences'}>Save preferences</Button>
        </form>
      </Card>

      <Card padding="lg" className="account-danger-card">
        <header><Trash2 aria-hidden="true" /><div><span>Permanent action</span><h3>Delete account</h3></div></header>
        <p>This removes the account and cascades owned access. Shared organization data follows its ownership rules.</p>
        <details><summary>Start account deletion</summary><form onSubmit={deleteAccount}>
          <label>Type {user.username}<input name="confirmation" autoComplete="off" required /></label>
          <label>Current password<input name="deletePassword" type="password" autoComplete="current-password" /></label>
          <Button type="submit" size="sm" variant="secondary" disabled={busy === 'delete'}>{busy === 'delete' ? 'Deleting…' : 'Delete account permanently'}</Button>
        </form></details>
      </Card>
    </div>
  </section>;
}
