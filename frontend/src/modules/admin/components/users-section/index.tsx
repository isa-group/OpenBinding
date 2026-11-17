import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MdPersonOff, MdSearch } from 'react-icons/md';
import type { AdminUserView } from '../../../core/api/account';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { EmptyState } from '../../../core/components/empty-state';
import { FilterPills } from '../../../core/components/filter-pills';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { useAuth } from '../../../auth/hooks/useAuth';
import { formatDate } from '../../../core/utils/format';
import { useResource } from '../../../core/hooks/useResource';
import { adminUserPath } from '../../../../routes/paths/admin';
import { useAdminApi } from '../../api/adminApi';
import { describeAdminFailure, planTone, type Failure } from '../../utils/adminModel';
import ConfirmDialog from '../confirm-dialog';
import {
  FailureNotice,
  FIELD,
  INPUT,
  LABEL,
  Loading,
  MUTED,
  Pager,
  SectionHeader,
  Tag,
  TOOLBAR,
} from '../admin-parts';

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
    title: name => `Deactivate ${name}?`,
    text: 'They can’t sign in or use their API keys from their next request, until you reactivate them. Their data stays.',
    confirm: 'Deactivate',
  },
  activate: {
    title: name => `Reactivate ${name}?`,
    text: 'They can sign in again with their existing credentials.',
    confirm: 'Reactivate',
  },
  admin: {
    title: name => `Make ${name} an administrator?`,
    text: 'They’ll be able to use every administration tool, including pricing and other people’s agreements.',
    confirm: 'Make administrator',
  },
  user: {
    title: name => `Remove administrator from ${name}?`,
    text: 'They keep their account and plan, but lose access to administration.',
    confirm: 'Make user',
  },
};

const SUCCESS: Record<Kind, (name: string) => string> = {
  deactivate: name => `${name} was deactivated.`,
  activate: name => `${name} was reactivated.`,
  admin: name => `${name} is now an administrator.`,
  user: name => `${name} is no longer an administrator.`,
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

/** The Accounts section of `/admin`: every account, with search, filters and the changes an administrator may make. */
export default function UsersSection() {
  const api = useAdminApi();
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

  const list = useResource(`admin-users:${query}:${offset}`, () =>
    api.adminListUsers({ search: query || undefined, offset, limit: PAGE })
  );
  const page = list.data ?? list.stale;
  const failure: Failure | null =
    list.status === 'error'
      ? describeAdminFailure(list.error, 'The accounts couldn’t be loaded')
      : null;

  const accounts = useMemo(() => page?.users ?? [], [page]);
  const plans = useMemo(
    () => [...new Set(accounts.map(account => account.plan))].sort(),
    [accounts]
  );
  const visible = accounts.filter(
    account =>
      (role === 'all' || account.role === role) &&
      matchesStatus(status, account) &&
      (!plan || account.plan === plan)
  );
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
      await api.adminUpdateUser(
        account.id,
        kind === 'activate' || kind === 'deactivate'
          ? { is_active: kind === 'activate' }
          : { role: kind }
      );
      setMessage({ tone: 'success', text: SUCCESS[kind](account.username) });
      list.reload();
    } catch (error: unknown) {
      const refused = describeAdminFailure(error, 'That change couldn’t be applied');
      setMessage(
        refused.code === 'cannot_demote_self'
          ? SELF_REFUSAL
          : { tone: refused.tone, title: refused.title, text: refused.text }
      );
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
    <>
      <SectionHeader
        title="Accounts"
        lede="Activate, deactivate or change the global role of an account. Passwords and email addresses can’t be changed here, and you can’t deactivate or demote yourself."
      />
      <form
        className={TOOLBAR}
        role="search"
        onSubmit={event => {
          event.preventDefault();
          setQuery(draft.trim());
          setOffset(0);
        }}
      >
        <label className="relative flex min-w-56 flex-[1_1_16rem] items-center">
          <MdSearch className="absolute left-3 h-4 w-4 text-tp-steel" aria-hidden="true" />
          <span className="sr-only">Search accounts</span>
          <input
            type="search"
            className={`${INPUT} pl-9`}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            placeholder="Username or email"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <FilterPills
          ariaLabel="Role"
          options={ROLES}
          value={role}
          onChange={id => setRole(id as RoleFilter)}
        />
        <FilterPills
          ariaLabel="Status"
          options={STATUSES}
          value={status}
          onChange={id => setStatus(id as StatusFilter)}
        />
        <label className={FIELD}>
          <span className={LABEL}>Plan</span>
          <select className={INPUT} value={plan} onChange={event => setPlan(event.target.value)}>
            <option value="">Any plan</option>
            {plans.map(id => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </form>

      {message && (
        <Notice tone={message.tone} title={message.title}>
          {message.text}
        </Notice>
      )}
      {failure && <FailureNotice failure={failure} onRetry={list.reload} />}

      {loading && (
        <Loading label="Loading accounts">
          <Skeleton variant="panel" />
        </Loading>
      )}

      {page && visible.length === 0 && !(page.total === 0 && !query) && (
        <EmptyState
          icon={<MdPersonOff />}
          title="No account matches"
          action={
            <Action size="sm" variant="secondary" onClick={clear}>
              Clear filters
            </Action>
          }
        >
          {filtering && accounts.length > 0
            ? 'No account on this page has that role, status and plan.'
            : 'Try another name or email.'}
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
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map(account => {
                const you = account.id === self?.id;
                return (
                  <tr
                    key={account.id}
                    aria-label={account.username}
                    className={account.is_active ? undefined : 'text-tp-steel'}
                  >
                    <td>
                      <Link
                        className="cursor-pointer font-medium text-tp-accent hover:underline"
                        to={adminUserPath(account.id)}
                      >
                        {account.username}
                      </Link>
                      {you && (
                        <>
                          {' '}
                          <Tag tone="info">you</Tag>
                        </>
                      )}
                      <span className="block text-xs [overflow-wrap:anywhere] text-tp-steel">
                        {account.email}
                      </span>
                    </td>
                    <td>
                      <Tag tone={account.role === 'admin' ? 'dark' : 'plain'}>
                        {account.role === 'admin' ? 'Admin' : 'User'}
                      </Tag>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        <Tag tone={planTone(account.plan)}>{account.plan}</Tag>
                        {account.cas_verified && (
                          <Tag tone="success">Institutional identity verified</Tag>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        <Tag tone={account.is_active ? 'info' : 'plain'}>
                          {account.is_active ? 'Active' : 'Inactive'}
                        </Tag>
                        {account.contract_pending && <Tag tone="warning">contract pending</Tag>}
                      </span>
                    </td>
                    <td>{account.api_key_count}</td>
                    <td className="text-tp-steel">{formatDate(account.created_at) ?? '—'}</td>
                    <td>
                      <span className="flex flex-wrap justify-end gap-3">
                        <Action
                          size="sm"
                          variant="link"
                          className={account.is_active ? '!text-tp-error-strong' : undefined}
                          aria-label={`${account.is_active ? 'Deactivate' : 'Reactivate'} ${account.username}`}
                          onClick={() =>
                            ask(account.is_active ? 'deactivate' : 'activate', account)
                          }
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
          <Pager
            offset={page.offset}
            limit={page.limit}
            total={page.total}
            shown={accounts.length}
            onPage={setOffset}
            noun="accounts"
          />
          {filtering && (
            <span className={MUTED}>
              Filters narrow the accounts on this page; the search above covers every account.
            </span>
          )}
        </>
      )}

      {page && page.total === 0 && !query && (
        <EmptyState icon={<MdPersonOff />} title="There are no accounts yet" dashed>
          Accounts appear here as people register.
        </EmptyState>
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
          <p className={MUTED}>The change is recorded in the audit log with your name.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
