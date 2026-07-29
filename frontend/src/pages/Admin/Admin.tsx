import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import type { AdminUserView, PlanName, UsageView } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';
import { QuotaBar, isBalance } from '../../components/QuotaBar';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Admin.css';

const PAGE_SIZE = 25;

export function Admin() {
  const { user: self } = useAuth();
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [inspecting, setInspecting] = useState<AdminUserView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await apiClient.adminListUsers({ search: search || undefined, offset, limit: PAGE_SIZE });
      setUsers(page.users);
      setTotal(page.total);
      setError(null);
    } catch {
      setError('The accounts could not be loaded.');
    }
  }, [search, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await what();
      setNotice(done);
      await load();
    } catch {
      setError('That change could not be applied. The pricing service may be unreachable.');
    }
  };

  const inspect = async (account: AdminUserView) => {
    setInspecting(account);
    setUsage(null);
    try {
      setUsage(await apiClient.adminGetUserUsage(account.id));
    } catch {
      setError(`Usage for ${account.username} could not be read.`);
    }
  };

  return (
    <div className="admin-page">
      <div className="container">
        <div className="page-header">
          <h1>Administration</h1>
          <p className="page-description">
            Accounts, plans and keys. Passwords and email addresses are deliberately not here:
            they are how somebody signs in, and changing them would be taking an account over.
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="success">{notice}</Alert>}

        <div className="admin-controls">
          <input
            className="admin-search"
            placeholder="Search by username or email..."
            value={search}
            onChange={(e) => {
              setOffset(0);
              setSearch(e.target.value);
            }}
          />
          <span className="admin-count">{total} account{total === 1 ? '' : 's'}</span>
        </div>

        <Card padding="lg" className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Role</th>
                <th>Keys</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((account) => {
                const isSelf = account.id === self?.id;
                return (
                  <tr key={account.id} className={account.is_active ? '' : 'admin-row-inactive'}>
                    <td>
                      <div className="admin-identity">
                        <strong>{account.username}</strong>
                        <span>{account.email}</span>
                      </div>
                    </td>
                    <td>
                      <select
                        value={account.plan}
                        aria-label={`Plan for ${account.username}`}
                        onChange={(e) =>
                          void act(
                            () => apiClient.adminChangePlan(account.id, e.target.value as PlanName),
                            `${account.username} moved to ${e.target.value}.`
                          )
                        }
                      >
                        <option value="BASIC">BASIC</option>
                        <option value="PRO">PRO</option>
                      </select>
                      {account.contract_pending && <Badge variant="warning">no contract</Badge>}
                    </td>
                    <td>
                      <select
                        value={account.role}
                        aria-label={`Role for ${account.username}`}
                        disabled={isSelf}
                        title={isSelf ? 'You cannot change your own role.' : undefined}
                        onChange={(e) =>
                          void act(
                            () =>
                              apiClient.adminUpdateUser(account.id, {
                                role: e.target.value as 'user' | 'admin',
                              }),
                            `${account.username} is now ${e.target.value}.`
                          )
                        }
                      >
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{account.api_key_count}</td>
                    <td>
                      <Badge variant={account.is_active ? 'success' : 'error'}>
                        {account.is_active ? 'active' : 'disabled'}
                      </Badge>
                    </td>
                    <td className="admin-actions">
                      <Button size="sm" variant="ghost" onClick={() => void inspect(account)}>
                        Usage
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isSelf}
                        title={isSelf ? 'You cannot deactivate your own account.' : undefined}
                        onClick={() =>
                          void act(
                            () =>
                              apiClient.adminUpdateUser(account.id, {
                                is_active: !account.is_active,
                              }),
                            `${account.username} ${account.is_active ? 'deactivated' : 'reactivated'}.`
                          )
                        }
                      >
                        {account.is_active ? 'Deactivate' : 'Reactivate'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {total > PAGE_SIZE && (
            <div className="admin-pager">
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <span>
                {offset + 1}&ndash;{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          )}
        </Card>

        {inspecting && (
          <Card padding="lg" className="admin-usage">
            <div className="admin-usage-head">
              <h2>{inspecting.username}</h2>
              <Button size="sm" variant="ghost" onClick={() => setInspecting(null)}>
                Close
              </Button>
            </div>

            {usage ? (
              <>
                <div className="admin-quotas">
                  {usage.limits
                    .filter((limit) => isBalance(limit.limit_id) && limit.limit > 0)
                    .map((limit) => (
                      <QuotaBar key={limit.limit_id} limit={limit} />
                    ))}
                </div>
                <p className="admin-note">
                  Concurrency is counted optimistically, so a crash between checking a slot and
                  claiming it can leave one held. Resynchronising counts the jobs actually
                  running and corrects the difference.
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void act(async () => {
                      const result = await apiClient.adminResyncUsage(inspecting.id);
                      setUsage(await apiClient.adminGetUserUsage(inspecting.id));
                      return result;
                    }, 'Usage resynchronised.')
                  }
                >
                  Resynchronise usage
                </Button>
              </>
            ) : (
              <p className="admin-note">Reading the contract...</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
