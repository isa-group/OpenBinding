// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: SPHERE has no administration frontend; one account is drawn on the card page's frame (the core resource card
// shell): the breadcrumb Administration / Accounts / username, the account's role and status under its name, its figures as
// stat tiles, and the tabs Identity, API keys, Agreement and Usage in the address (`?tab=`). A missing account is the in-place
// 404; any other refusal is said on the page.

import { useState, type FormEvent } from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams, useSearchParams } from 'react-router-dom';
import { MdKey } from 'react-icons/md';
import { HttpError } from '../../../core/api/http';
import { Action } from '../../../core/components/action-button';
import { CopyField } from '../../../core/components/copy-field';
import { Notice } from '../../../core/components/notice';
import ResourceCardShell, {
  type ShellCrumb,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import { Skeleton } from '../../../core/components/skeleton';
import { useAuth } from '../../../auth/hooks/useAuth';
import NotFoundPage from '../../../core/pages/page-not-found';
import { formatDate } from '../../../core/utils/format';
import { useResource } from '../../../core/hooks/useResource';
import {
  adminPath,
  adminUserPath,
  adminUserTabOf,
  type AdminUserTab,
} from '../../../../routes/paths/admin';
import { useAdminApi, type AdminApi } from '../../api/adminApi';
import { AgreementCard, UsageCard, type AgreementResult } from '../../components/agreement-card';
import {
  Card,
  FACTS,
  FailureNotice,
  FIELD,
  INPUT,
  LABEL,
  Loading,
  MUTED,
  Tag,
} from '../../components/admin-parts';
import ConfirmDialog from '../../components/confirm-dialog';
import {
  describeAdminFailure,
  readContractCatalog,
  UUID,
  type Failure,
} from '../../utils/adminModel';

interface Message {
  tone: 'success' | 'error' | 'warning';
  title?: string;
  text: string;
}

/**
 * An address names the account by its id, or by its username or email: the gateway’s own identifier is the id. The account comes
 * with the revision of its subscription, which a change decided on this reading sends back.
 */
async function loadAccount(api: AdminApi, param: string) {
  let id = param;
  if (!UUID.test(param)) {
    const found = await api.adminListUsers({ search: param, limit: 200 });
    const wanted = param.toLowerCase();
    const match = found.users.find(
      account => account.username.toLowerCase() === wanted || account.email.toLowerCase() === wanted
    );
    if (!match) throw new HttpError(404, 'No such account.');
    id = match.id;
  }
  return api.adminGetSubscription(id);
}

/** The active pricing, read for contracts, and the document itself, which the review of a change draws. */
async function loadCatalog(api: AdminApi) {
  const published = await api.getPlansPricing();
  return {
    catalog: readContractCatalog(published.document),
    document: published.document,
    current: { version: published.version },
  };
}

function KeysCard({
  userId,
  username,
  count,
}: {
  userId: string;
  username: string;
  count: number;
}) {
  const api = useAdminApi();
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
      await api.adminRevokeApiKey(userId, keyId.trim());
      setMessage({
        tone: 'success',
        text: 'Key revoked. Requests with it fail from now on. It is recorded in the audit log with your name.',
      });
      setKeyId('');
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'The key couldn’t be revoked');
      setMessage(
        refused.status === 404
          ? {
              tone: 'error',
              title: 'No such API key (404)',
              text: `${username} has no active key with that id.`,
            }
          : { tone: refused.tone, title: refused.title, text: refused.text }
      );
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <Card title="API keys" aside={`${count} active`}>
      <p className={MUTED}>
        The gateway keeps keys private to their owner: it doesn’t list another account’s keys, names
        or permissions to an administrator. A key can be taken back by its id when its owner can’t
        be reached, for example after a leak.
      </p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
        <label className={`${FIELD} flex-[1_1_14rem]`}>
          <span className={LABEL}>Key id</span>
          <input
            className={`${INPUT} font-mono`}
            value={keyId}
            onChange={event => {
              setKeyId(event.target.value);
              setMessage(null);
            }}
            placeholder="Key id from the user’s key list"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <Action type="submit" variant="danger-outline" disabled={!valid}>
          <MdKey aria-hidden="true" />
          Revoke key
        </Action>
      </form>
      {keyId.trim() !== '' && !valid && (
        <span className={MUTED}>A key id is a UUID, like the one in a support request.</span>
      )}
      {message && (
        <Notice tone={message.tone} title={message.title}>
          {message.text}
        </Notice>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Revoke the key of ${username}?`}
          tone="danger"
          confirmLabel="Revoke key"
          confirmVariant="danger"
          busy={busy}
          onConfirm={() => void revoke()}
          onClose={() => setConfirm(false)}
        >
          <p>
            Whatever uses this key stops working immediately. The owner is not asked first, and it
            can’t be undone; they can create a new key.
          </p>
          <p className={MUTED}>
            <code className="font-mono">{keyId.trim()}</code>
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

const TAB_LABELS: Record<AdminUserTab, string> = {
  identity: 'Identity',
  keys: 'API keys',
  agreement: 'Agreement',
  usage: 'Usage',
};

function DetailScreen({ param, tab }: { param: string; tab: AdminUserTab }) {
  const api = useAdminApi();
  const [message, setMessage] = useState<Message | null>(null);
  const account = useResource(`admin-account:${param}`, () => loadAccount(api, param));
  const pricing = useResource('admin-pricing-catalog', () => loadCatalog(api));
  // The view and its revision come from the same answer, so a change is never sent with the revision of another reading.
  const read = account.data ?? account.stale;
  const view = read?.value;
  const failure: Failure | null =
    account.status === 'error'
      ? describeAdminFailure(account.error, 'The account couldn’t be read')
      : null;
  const catalogFailure =
    pricing.status === 'error'
      ? describeAdminFailure(pricing.error, 'The pricing couldn’t be read')
      : null;
  const catalog = (pricing.data ?? pricing.stale)?.catalog ?? null;
  const pricingDocument = (pricing.data ?? pricing.stale)?.document ?? null;
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

  // A change decided on a subscription that has moved since: the card says so. What an earlier change left is no longer what the
  // account has, so its message goes, and the subscription is read again for the review to be drawn from.
  const outdated = () => {
    setMessage(null);
    account.reload();
  };

  const crumbs = (name: string): ShellCrumb[] => [
    { label: 'Administration', to: adminPath() },
    { label: 'Accounts', to: adminPath('users') },
    { label: name },
  ];
  const tabs = (id: string): ShellTab[] =>
    (Object.keys(TAB_LABELS) as AdminUserTab[]).map(item => ({
      id: item,
      label: TAB_LABELS[item],
      to: adminUserPath(id, item),
    }));
  const title = (
    <Helmet>
      <title>OpenBinding - Administration</title>
    </Helmet>
  );

  // A missing account reads like any other missing page.
  if (failure && !view && failure.status === 404) return <NotFoundPage />;

  if (!view) {
    return (
      <>
        {title}
        <ResourceCardShell
          crumbs={crumbs(param)}
          title={param}
          tabs={tabs(param)}
          activeTab={tab}
          tabsLabel="Account"
        >
          {failure ? (
            <FailureNotice failure={failure} onRetry={account.reload} />
          ) : (
            <Loading label="Reading the account">
              <div className="grid gap-4 md:grid-cols-2">
                <Skeleton variant="card" />
                <Skeleton variant="card" />
              </div>
            </Loading>
          )}
        </ResourceCardShell>
      </>
    );
  }

  const { user, subscription } = view;
  return (
    <>
      {title}
      <ResourceCardShell
        crumbs={crumbs(user.username)}
        title={user.username}
        subtitle={
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-tp-steel">
            <Tag tone={user.role === 'admin' ? 'dark' : 'plain'}>
              {user.role === 'admin' ? 'Admin' : 'User'}
            </Tag>
            <Tag tone={user.is_active ? 'info' : 'plain'}>
              {user.is_active ? 'Active' : 'Inactive'}
            </Tag>
            <span>
              {user.email} · since {formatDate(user.created_at) ?? '—'}
            </span>
          </div>
        }
        actions={
          <Action size="sm" variant="secondary" to={adminPath('users')}>
            All accounts
          </Action>
        }
        stats={[
          { label: 'Plan', value: subscription.plan },
          { label: 'Pricing pinned', value: subscription.pricing_version },
          { label: 'API keys', value: user.api_key_count },
          { label: 'Contract', value: user.contract_pending ? 'Pending' : 'Settled' },
        ]}
        tabs={tabs(user.id)}
        activeTab={tab}
        tabsLabel="Account"
      >
        <div className="flex flex-col gap-4">
          {message && (
            <Notice tone={message.tone} title={message.title}>
              {message.text}
            </Notice>
          )}
          {failure && <FailureNotice failure={failure} onRetry={account.reload} />}

          {tab === 'identity' && (
            <Card title="Identity">
              <dl className={FACTS} aria-label="Account facts">
                <div>
                  <dt>Plan</dt>
                  <dd>
                    <Tag tone="dark">{subscription.plan}</Tag>
                  </dd>
                </div>
                <div>
                  <dt>Institutional identity</dt>
                  <dd>
                    {user.cas_verified ? (
                      <Tag tone="success">Institutional identity verified</Tag>
                    ) : (
                      'None linked'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Contract</dt>
                  <dd>
                    {user.contract_pending
                      ? 'Pending: settles on the next authenticated request'
                      : 'Settled'}
                  </dd>
                </div>
                <div>
                  <dt>Pricing pinned</dt>
                  <dd>{subscription.pricing_version}</dd>
                </div>
                <div>
                  <dt>API keys</dt>
                  <dd>{user.api_key_count}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{user.email}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt>Account id</dt>
                  <dd>
                    <CopyField value={user.id} label="account id" />
                  </dd>
                </div>
              </dl>
            </Card>
          )}

          {tab === 'keys' && (
            <KeysCard userId={user.id} username={user.username} count={user.api_key_count} />
          )}

          {/* Not remounted when the subscription is read again: a review that was open is drawn again from the new reading. */}
          {tab === 'agreement' && (
            <AgreementCard
              view={view}
              revision={read?.etag ?? null}
              reading={account.status === 'loading'}
              catalog={catalog}
              pricing={pricingDocument}
              catalogFailure={catalogFailure}
              catalogLoading={pricing.status === 'loading' && !pricing.stale}
              current={current}
              onApplied={applied}
              onOutdated={outdated}
            />
          )}

          {tab === 'usage' && (
            <UsageCard
              userId={user.id}
              catalog={catalog}
              version={`${subscription.plan}:${JSON.stringify(subscription.add_ons)}`}
            />
          )}
        </div>
      </ResourceCardShell>
    </>
  );
}

/** `/admin/users/:user` (admin-user-detail): one account’s identity, keys, agreement and usage, on the card shell. */
export default function AdminUserPage() {
  const { isAdmin } = useAuth();
  const { user } = useParams();
  const [params] = useSearchParams();
  // Administration is unreadable to everybody else, and anything unreadable is the same in-place 404 as a missing page.
  if (!isAdmin) return <NotFoundPage />;
  return <DetailScreen key={user} param={user ?? ''} tab={adminUserTabOf(params.get('tab'))} />;
}
