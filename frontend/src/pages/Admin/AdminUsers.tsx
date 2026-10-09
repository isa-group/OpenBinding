import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, UserX } from 'lucide-react';
import type { AdminUserView } from '../../api/auth';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { AdminFrame, AdminOnly, FailureNotice, Pager, Tag } from './AdminChrome';
import { describeAdminFailure, planTone, type Failure } from './adminModel';

const PAGE = 50;

type RoleFilter = 'all' | 'admin' | 'user';
type StatusFilter = 'all' | 'active' | 'inactive' | 'pending';
type Kind = 'deactivate' | 'activate' | 'admin' | 'user';

const ROLES = [
  { id: 'all', label: 'Any role' },
  { id: 'admin', label: 'Admins' },
  { id: 'user', label: 'Users' },
] as const;

const STATUSES = [
  { id: 'all', label: 'Any status' },
  { id: 'active', label: 'Active' },
  { id: 'inactive', label: 'Inactive' },
  { id: 'pending', label: 'Contract pending' },
] as const;

const WORDING: Record<Kind, { title: (name: string) => string; text: string; confirm: string }> = {
  deactivate: {
    title: (name) => `Deactivate ${name}?`,
    text: 'They can’t sign in or use their API keys from their next request, until you reactivate them. Their data stays.',
    confirm: 'Deactivate',
  },
  activate: {
    title: (name) => `Reactivate ${name}?`,
    text: 'They can sign in again with their existing credentials.',
    confirm: 'Reactivate',
  },
  admin: {
    title: (name) => `Make ${name} an administrator?`,
    text: 'They’ll be able to use every administration tool, including pricing and other people’s agreements.',
    confirm: 'Make administrator',
  },
  user: {
    title: (name) => `Remove administrator from ${name}?`,
    text: 'They keep their account and plan, but lose access to administration.',
    confirm: 'Make user',
  },
};

const SUCCESS: Record<Kind, (name: string) => string> = {
  deactivate: (name) => `${name} was deactivated.`,
  activate: (name) => `${name} was reactivated.`,
  admin: (name) => `${name} is now an administrator.`,
  user: (name) => `${name} is no longer an administrator.`,
};

interface Message {
  tone: 'success' | 'error' | 'warning';
  title?: string;
  text: string;
}

const SELF_REFUSAL: Message = {
  tone: 'error',
  title: 'You can’t demote or deactivate yourself (409 · cannot_demote_self)',
  text: 'Another administrator has to do it. This keeps the platform from ending up without anyone able to manage it.',
};

function matchesStatus(filter: StatusFilter, account: AdminUserView): boolean {
  if (filter === 'active') return account.is_active;
  if (filter === 'inactive') return !account.is_active;
  if (filter === 'pending') return account.contract_pending;
  return true;
}

function UsersScreen() {
  const { user: self } = useAuth();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [plan, setPlan] = useState('');
  const [pending, setPending] = useState<{ kind: Kind; account: AdminUserView } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  // Typing searches the gateway after a short pause; the page starts again from the first account.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(draft.trim());
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const list = useResource(`admin-users:${query}:${offset}`, () => apiClient.adminListUsers({ search: query || undefined, offset, limit: PAGE }));
  const page = list.data ?? list.stale;
  const failure: Failure | null = list.status === 'error' ? describeAdminFailure(list.error, 'The accounts couldn’t be loaded') : null;

  const accounts = useMemo(() => page?.users ?? [], [page]);
  const plans = useMemo(() => [...new Set(accounts.map((account) => account.plan))].sort(), [accounts]);
  const visible = accounts.filter((account) => (
    (role === 'all' || account.role === role) && matchesStatus(status, account) && (!plan || account.plan === plan)
  ));
  const filtering = role !== 'all' || status !== 'all' || plan !== '';

  const ask = (kind: Kind, account: AdminUserView) => {
    setMessage(null);
    // The gateway would refuse these with a 409; saying so now spares the round trip.
    if (account.id === self?.id && (kind === 'deactivate' || kind === 'user')) {
      setMessage(SELF_REFUSAL);
      return;
    }
    setPending({ kind, account });
  };

  const apply = async () => {
    if (!pending) return;
    const { kind, account } = pending;
    setBusy(true);
    try {
      await apiClient.adminUpdateUser(account.id, kind === 'activate' || kind === 'deactivate' ? { is_active: kind === 'activate' } : { role: kind });
      setMessage({ tone: 'success', text: SUCCESS[kind](account.username) });
      list.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'That change couldn’t be applied');
      setMessage(refused.code === 'cannot_demote_self'
        ? SELF_REFUSAL
        : { tone: refused.tone, title: refused.title, text: refused.text });
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const clear = () => {
    setDraft('');
    setQuery('');
    setOffset(0);
    setRole('all');
    setStatus('all');
    setPlan('');
  };

  const loading = list.status === 'loading' && !page;

  return (
    <AdminFrame
      section="users"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Accounts' }]}
      title="Accounts"
      lede="Activate, deactivate or change the global role of an account. Passwords and email addresses can’t be changed here, and you can’t deactivate or demote yourself."
    >
      <form className="adm-toolbar" role="search" onSubmit={(event) => { event.preventDefault(); setQuery(draft.trim()); setOffset(0); }}>
        <label className="adm-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search accounts</span>
          <input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Username or email" autoComplete="off" spellCheck={false} />
        </label>
        <FilterPills ariaLabel="Role" options={ROLES} value={role} onChange={(id) => setRole(id as RoleFilter)} />
        <FilterPills ariaLabel="Status" options={STATUSES} value={status} onChange={(id) => setStatus(id as StatusFilter)} />
        <label className="adm-select">
          <span>Plan</span>
          <select value={plan} onChange={(event) => setPlan(event.target.value)}>
            <option value="">Any plan</option>
            {plans.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
      </form>

      {message && <Notice tone={message.tone} title={message.title}>{message.text}</Notice>}
      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}

      {loading && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading accounts</span><Skeleton variant="panel" /></div>}

      {page && visible.length === 0 && !(page.total === 0 && !query) && (
        <EmptyState
          icon={<UserX />}
          title="No account matches"
          action={<Action size="sm" variant="secondary" onClick={clear}>Clear filters</Action>}
        >
          {filtering && accounts.length > 0 ? 'No account on this page has that role, status and plan.' : 'Try another name or email.'}
        </EmptyState>
      )}

      {page && visible.length > 0 && (
        <>
          <DataTable label="Accounts" minWidth={980}>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
                <th scope="col">Plan</th>
                <th scope="col">Status</th>
                <th scope="col">Keys</th>
                <th scope="col">Since</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="adm-rows">
              {visible.map((account) => {
                const you = account.id === self?.id;
                return (
                  <tr key={account.id} aria-label={account.username} className={account.is_active ? undefined : 'is-inactive'}>
                    <td>
                      <Link className="adm-name" to={`/app/admin/users/${account.id}`} viewTransition>{account.username}</Link>
                      {you && <> <Tag tone="info">you</Tag></>}
                      <span className="adm-sub">{account.email}</span>
                    </td>
                    <td data-label="Role"><Tag tone={account.role === 'admin' ? 'dark' : 'plain'}>{account.role === 'admin' ? 'Admin' : 'User'}</Tag></td>
                    <td data-label="Plan">
                      <Tag tone={planTone(account.plan)}>{account.plan}</Tag>
                      {account.cas_verified && <span className="adm-cas"> ✓ CAS</span>}
                    </td>
                    <td data-label="Status">
                      <Tag tone={account.is_active ? 'info' : 'plain'}>{account.is_active ? 'Active' : 'Inactive'}</Tag>
                      {account.contract_pending && <> <Tag tone="warning">contract pending</Tag></>}
                    </td>
                    <td data-label="Keys">{account.api_key_count}</td>
                    <td data-label="Since" className="adm-muted">{formatDate(account.created_at) ?? '—'}</td>
                    <td>
                      <span className="adm-actions">
                        <Action
                          size="sm"
                          variant="link"
                          className={account.is_active ? 'adm-danger-link' : undefined}
                          aria-label={`${account.is_active ? 'Deactivate' : 'Reactivate'} ${account.username}`}
                          onClick={() => ask(account.is_active ? 'deactivate' : 'activate', account)}
                        >
                          {account.is_active ? 'Deactivate' : 'Reactivate'}
                        </Action>
                        <Action
                          size="sm"
                          variant="link"
                          aria-label={`${account.role === 'admin' ? 'Make user' : 'Make admin'} ${account.username}`}
                          onClick={() => ask(account.role === 'admin' ? 'user' : 'admin', account)}
                        >
                          {account.role === 'admin' ? 'Make user' : 'Make admin'}
                        </Action>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <Pager offset={page.offset} limit={page.limit} total={page.total} shown={accounts.length} onPage={setOffset} noun="accounts" />
          {filtering && <span className="adm-muted">Filters narrow the accounts on this page; the search above covers every account.</span>}
        </>
      )}

      {page && page.total === 0 && !query && (
        <EmptyState icon={<UserX />} title="There are no accounts yet" dashed>Accounts appear here as people register.</EmptyState>
      )}

      {pending && (
        <ConfirmDialog
          title={WORDING[pending.kind].title(pending.account.username)}
          tone={pending.kind === 'deactivate' ? 'danger' : 'default'}
          confirmLabel={WORDING[pending.kind].confirm}
          confirmVariant={pending.kind === 'deactivate' ? 'danger' : 'primary'}
          busy={busy}
          onConfirm={() => void apply()}
          onClose={() => setPending(null)}
        >
          <p>{WORDING[pending.kind].text}</p>
          <p className="adm-muted">The gateway doesn’t write this change to the audit log.</p>
        </ConfirmDialog>
      )}
    </AdminFrame>
  );
}

/** admin-users: every account, with search, filters and the changes an administrator may make. */
export function AdminUsers() {
  return <AdminOnly><UsersScreen /></AdminOnly>;
}
