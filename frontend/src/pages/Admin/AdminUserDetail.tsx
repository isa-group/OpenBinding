import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { KeyRound, UserX } from 'lucide-react';
import { apiClient, HttpError } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { AgreementCard, UsageCard, type AgreementResult } from './AdminAgreement';
import { AdminFrame, AdminOnly, FailureNotice, Tag } from './AdminChrome';
import { describeAdminFailure, readContractCatalog, UUID, type Failure } from './adminModel';

interface Message {
  tone: 'success' | 'error' | 'warning';
  title?: string;
  text: string;
}

/** An address names the account by its id, or by its username or email: the gateway’s own identifier is the id. */
async function loadAccount(param: string) {
  let id = param;
  if (!UUID.test(param)) {
    const found = await apiClient.adminListUsers({ search: param, limit: 200 });
    const wanted = param.toLowerCase();
    const match = found.users.find((account) => account.username.toLowerCase() === wanted || account.email.toLowerCase() === wanted);
    if (!match) throw new HttpError(404, 'No such account.');
    id = match.id;
  }
  return apiClient.adminGetSubscription(id);
}

async function loadCatalog() {
  const [catalog, current] = await Promise.all([apiClient.getPricingCatalog(), apiClient.getCurrentPricing().catch(() => null)]);
  return { catalog: readContractCatalog(catalog), current };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="adm-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function KeysCard({ userId, username, count }: { userId: string; username: string; count: number }) {
  const [keyId, setKeyId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const valid = UUID.test(keyId.trim());

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) setConfirm(true);
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await apiClient.adminRevokeApiKey(userId, keyId.trim());
      setMessage({ tone: 'success', text: 'Key revoked. Requests with it fail from now on. The gateway doesn’t write this to the audit log.' });
      setKeyId('');
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'The key couldn’t be revoked');
      setMessage(refused.status === 404
        ? { tone: 'error', title: 'No such API key (404)', text: `${username} has no active key with that id.` }
        : { tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <section className="adm-card" aria-labelledby="adm-keys-title">
      <div className="adm-card-head">
        <h2 id="adm-keys-title">API keys</h2>
        <span className="adm-muted">{count} active</span>
      </div>
      <p className="adm-muted">
        The gateway keeps keys private to their owner: it doesn’t list another account’s keys, names or permissions to an administrator.
        A key can be taken back by its id when its owner can’t be reached, for example after a leak.
      </p>
      <form className="adm-inline-form" onSubmit={submit}>
        <label className="adm-field">
          <span className="adm-label">Key id</span>
          <input value={keyId} onChange={(event) => { setKeyId(event.target.value); setMessage(null); }} placeholder="00000000-0000-4000-8000-000000000000" autoComplete="off" spellCheck={false} />
        </label>
        <Action type="submit" variant="danger-outline" disabled={!valid}><KeyRound aria-hidden="true" />Revoke key</Action>
      </form>
      {keyId.trim() !== '' && !valid && <span className="adm-muted">A key id is a UUID, like the one in a support request.</span>}
      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {confirm && (
        <ConfirmDialog title={`Revoke the key of ${username}?`} tone="danger" confirmLabel="Revoke key" confirmVariant="danger" busy={busy} onConfirm={() => void revoke()} onClose={() => setConfirm(false)}>
          <p>Whatever uses this key stops working immediately. The owner is not asked first, and it can’t be undone; they can create a new key.</p>
          <p className="adm-muted"><code>{keyId.trim()}</code></p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function OrganizationsCard() {
  const navigate = useNavigate();
  const [organization, setOrganization] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = organization.trim();
    if (value) void navigate(`/app/admin/organizations/${encodeURIComponent(value)}/sponsor`);
  };
  return (
    <section className="adm-card" aria-labelledby="adm-orgs-title">
      <div className="adm-card-head">
        <h2 id="adm-orgs-title">Organizations</h2>
        <span className="adm-muted">Not listed by the gateway</span>
      </div>
      <p className="adm-muted">
        The gateway has no list of the organizations an account belongs to or sponsors that an administrator can read. If you know the
        organization, you can open its billing sponsorship, where an account can be set as sponsor.
      </p>
      <form className="adm-inline-form" onSubmit={submit}>
        <label className="adm-field">
          <span className="adm-label">Organization slug or id</span>
          <input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="isa-demo" autoComplete="off" spellCheck={false} />
        </label>
        <Action type="submit" variant="secondary" disabled={!organization.trim()}>Open sponsorship</Action>
      </form>
    </section>
  );
}

function DetailScreen({ param }: { param: string }) {
  const [message, setMessage] = useState<Message | null>(null);
  const account = useResource(`admin-account:${param}`, () => loadAccount(param));
  const pricing = useResource('admin-pricing-catalog', loadCatalog);
  const view = account.data ?? account.stale;
  const failure: Failure | null = account.status === 'error' ? describeAdminFailure(account.error, 'The account couldn’t be read') : null;
  const catalogFailure = pricing.status === 'error' ? describeAdminFailure(pricing.error, 'The pricing couldn’t be read') : null;
  const catalog = (pricing.data ?? pricing.stale)?.catalog ?? null;
  const current = (pricing.data ?? pricing.stale)?.current ?? null;

  const applied = (result: AgreementResult) => {
    const name = view?.user.username ?? 'The account';
    setMessage({
      tone: 'success',
      text: result.changed
        ? `Agreement updated for ${name} (${result.reason}). ${name} now uses ${result.plan}; the account was notified and the change is in the audit log.`
        : 'No contract values changed, so no notification was sent.',
    });
    account.reload();
  };

  if (failure && !view) {
    return (
      <AdminFrame section="users" trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Accounts', to: '/app/admin/users' }, { label: param, mono: true }]} title="Account">
        {failure.status === 404 ? (
          <EmptyState
            icon={<UserX />}
            title="No such account"
            action={<Action size="sm" variant="secondary" to="/app/admin/users">Back to accounts</Action>}
          >
            Nothing matches “{param}”. Use the account’s id, username or email.
          </EmptyState>
        ) : (
          <FailureNotice failure={failure} onRetry={account.reload} />
        )}
      </AdminFrame>
    );
  }

  if (!view) {
    return (
      <AdminFrame section="users" trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Accounts', to: '/app/admin/users' }, { label: param, mono: true }]} title="Account">
        <div className="adm-grid" aria-busy="true"><span className="sr-only">Reading the account</span><Skeleton variant="card" /><Skeleton variant="card" /><Skeleton variant="card" /></div>
      </AdminFrame>
    );
  }

  const { user, subscription } = view;
  return (
    <AdminFrame
      section="users"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Accounts', to: '/app/admin/users' }, { label: user.username, mono: true }]}
      title={user.username}
      badges={<><Tag tone={user.role === 'admin' ? 'dark' : 'plain'}>{user.role === 'admin' ? 'Admin' : 'User'}</Tag><Tag tone={user.is_active ? 'info' : 'plain'}>{user.is_active ? 'Active' : 'Inactive'}</Tag></>}
      lede={<>{user.email} · since {formatDate(user.created_at) ?? '—'}. <Link to="/app/admin/users" viewTransition>All accounts</Link></>}
    >
      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {failure && <FailureNotice failure={failure} onRetry={account.reload} />}

      <dl className="adm-facts" aria-label="Account facts">
        <Fact label="Plan"><Tag tone="dark">{subscription.plan}</Tag></Fact>
        <Fact label="CAS identity">{user.cas_verified ? 'Verified (us-cas)' : 'Not shown by the gateway'}</Fact>
        <Fact label="Contract">{user.contract_pending ? 'Pending: settles on the next authenticated request' : 'Settled'}</Fact>
        <Fact label="Pricing pinned">{subscription.pricing_version}</Fact>
        <Fact label="API keys">{user.api_key_count}</Fact>
        <Fact label="Account id"><CopyField value={user.id} label="account id" truncate /></Fact>
      </dl>

      <AgreementCard
        key={`${subscription.plan}:${JSON.stringify(subscription.add_ons)}:${subscription.pricing_version}`}
        view={view}
        catalog={catalog}
        catalogFailure={catalogFailure}
        catalogLoading={pricing.status === 'loading' && !pricing.stale}
        current={current}
        onApplied={applied}
      />

      <div className="adm-grid">
        <UsageCard userId={user.id} catalog={catalog} version={`${subscription.plan}:${JSON.stringify(subscription.add_ons)}`} />
        <div className="adm-stack">
          <KeysCard userId={user.id} username={user.username} count={user.api_key_count} />
          <OrganizationsCard />
        </div>
      </div>
    </AdminFrame>
  );
}

/** admin-user-detail: one account’s identity, agreement, usage and the administrative actions on it. */
export function AdminUserDetail() {
  const { user } = useParams();
  return <AdminOnly><DetailScreen key={user} param={user ?? ''} /></AdminOnly>;
}
