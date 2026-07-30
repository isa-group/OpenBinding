import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../api/client';
import type { AdminUserView, PlanName, UsageView } from '../../api/auth';
import type { RegisteredEngine } from '../../api/client';
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
  // Publication is a request somebody has to answer. Without this the owner
  // asks and nothing ever happens, which is a worse outcome than not offering
  // to publish at all.
  const [engines, setEngines] = useState<RegisteredEngine[]>([]);
  const [showAllEngines, setShowAllEngines] = useState(false);

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

  const loadEngines = useCallback(async () => {
    try {
      setEngines(await apiClient.adminListEngines(!showAllEngines));
    } catch {
      setError('The registered engines could not be loaded.');
    }
  }, [showAllEngines]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadEngines();
  }, [loadEngines]);

  const act = async (what: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await what();
      setNotice(done);
      await load();
      await loadEngines();
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
                        <option value="FREE">FREE</option>
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

        <Card padding="lg" className="admin-engines">
          <div className="admin-usage-head">
            <h2>Registered engines</h2>
            <label className="admin-toggle">
              <input
                type="checkbox"
                checked={showAllEngines}
                onChange={(e) => setShowAllEngines(e.target.checked)}
              />
              <span>Show every registration, not only those awaiting review</span>
            </label>
          </div>

          {engines.length === 0 ? (
            <p className="admin-empty">
              {showAllEngines
                ? 'Nobody has registered an engine yet.'
                : 'Nothing is waiting for review.'}
            </p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Engine</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Visibility</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {engines.map((engine) => (
                  <tr key={engine.id}>
                    <td>
                      <div className="admin-identity">
                        <strong>{engine.display_name}</strong>
                        <span>{engine.engine_id}</span>
                      </div>
                    </td>
                    <td>{engine.owner}</td>
                    <td>
                      <Badge variant={engine.status === 'active' ? 'success' : 'error'}>
                        {engine.status}
                      </Badge>
                      {engine.conformance_report && !engine.conformance_report.passed && (
                        <div
                          className="admin-finding"
                          title={engine.conformance_report.findings
                            .map((f) => f.message)
                            .join('\n')}
                        >
                          {engine.conformance_report.findings[0]?.code}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge
                        variant={engine.visibility === 'public' ? 'accent' : 'default'}
                      >
                        {engine.visibility.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="admin-actions">
                      {engine.visibility === 'pending_review' && (
                        <>
                          <Button
                            size="sm"
                            // Only a verified engine can be approved; the
                            // gateway refuses otherwise, and offering the
                            // button anyway would be offering a 409.
                            disabled={engine.status !== 'active'}
                            title={
                              engine.status === 'active'
                                ? 'List this engine for everybody'
                                : 'This engine does not pass its own conformance checks'
                            }
                            onClick={() =>
                              act(
                                () => apiClient.adminApproveEngine(engine.engine_id),
                                `${engine.engine_id} is now public.`
                              )
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              act(
                                () => apiClient.adminRejectEngine(engine.engine_id),
                                `${engine.engine_id} stays private.`
                              )
                            }
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {engine.status !== 'disabled' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Stop it being solved on, without deleting it"
                          onClick={() =>
                            act(
                              () => apiClient.adminDisableEngine(engine.engine_id),
                              `${engine.engine_id} is disabled.`
                            )
                          }
                        >
                          Disable
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
