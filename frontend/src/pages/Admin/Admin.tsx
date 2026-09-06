import { useCallback, useEffect, useMemo, useState } from 'react';
import { retrievePricingFromYaml } from 'pricing4ts';
import type { Pricing } from 'pricing4ts';
import { apiClient, bimResourceKey } from '../../api/client';
import type {
  AdminSubscriptionView,
  AdminUserView,
  ContractChangeReason,
  UsageView,
} from '../../api/auth';
import type { EngineRegistrationReport, EngineRegistrationRevision } from '../../api/client';
import { useAuth } from '../../contexts/auth';
import { QuotaBar } from '../../components/QuotaBar';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { AdminOperations } from './AdminOperations';
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
  const [subscription, setSubscription] = useState<AdminSubscriptionView | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [editingPlan, setEditingPlan] = useState('');
  const [editingAddOns, setEditingAddOns] = useState<Record<string, number>>({});
  const [changeReason, setChangeReason] = useState<ContractChangeReason>('administrative_decision');
  const [changeDetail, setChangeDetail] = useState('');
  const [contractBusy, setContractBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [registrations, setRegistrations] = useState<EngineRegistrationRevision[]>([]);
  const [reviewing, setReviewing] = useState<EngineRegistrationRevision | null>(null);
  const [reviewReport, setReviewReport] = useState<EngineRegistrationReport | null>(null);

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

  const loadRegistrations = useCallback(async () => {
    try {
      setRegistrations(await apiClient.adminListEngineRegistrations());
    } catch {
      setError('The publication review queue could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  useEffect(() => {
    void Promise.resolve().then(loadRegistrations);
  }, [loadRegistrations]);

  useEffect(() => {
    void apiClient.getPricingDocument()
      .then((source) => setPricing(retrievePricingFromYaml(source)))
      .catch(() => setError('The active iPricing could not be loaded. Contract editing is unavailable.'));
  }, []);

  const planOptions = Object.entries(pricing?.plans ?? {});
  const addOnOptions = useMemo(
    () => Object.entries(pricing?.addOns ?? {}).filter(([, addOn]) => addOn.availableFor.includes(editingPlan)),
    [editingPlan, pricing],
  );
  const subscriptionIssues = useMemo(() => {
    if (!pricing?.plans?.[editingPlan]) return ['Choose a plan from the active iPricing.'];
    const selected = Object.fromEntries(Object.entries(editingAddOns).filter(([, quantity]) => quantity > 0));
    const issues: string[] = [];
    for (const [id, quantity] of Object.entries(selected)) {
      const addOn = pricing.addOns?.[id];
      if (!addOn || !addOn.availableFor.includes(editingPlan)) {
        issues.push(`${id} is not available for ${editingPlan}.`);
        continue;
      }
      const { minQuantity, maxQuantity, quantityStep } = addOn.subscriptionConstraints;
      if (!Number.isInteger(quantity) || quantity < minQuantity || quantity > maxQuantity || (quantity - minQuantity) % quantityStep !== 0) {
        issues.push(`${addOn.name} must be ${minQuantity}–${maxQuantity} in steps of ${quantityStep}.`);
      }
      for (const dependency of addOn.dependsOn ?? []) {
        if (!selected[dependency]) issues.push(`${addOn.name} depends on ${pricing.addOns?.[dependency]?.name ?? dependency}.`);
      }
      for (const excluded of addOn.excludes ?? []) {
        if (selected[excluded]) issues.push(`${addOn.name} excludes ${pricing.addOns?.[excluded]?.name ?? excluded}.`);
      }
    }
    return [...new Set(issues)];
  }, [editingAddOns, editingPlan, pricing]);

  const act = async (what: () => Promise<unknown>, done: string) => {
    setError(null);
    setNotice(null);
    try {
      await what();
      setNotice(done);
      setReviewing(null);
      setReviewReport(null);
      await load();
      await loadRegistrations();
    } catch {
      setError('That change could not be applied. The gateway may have refused it or a required service may be unavailable.');
    }
  };

  const inspect = async (account: AdminUserView) => {
    setInspecting(account);
    setUsage(null);
    setSubscription(null);
    try {
      const [nextUsage, nextSubscription] = await Promise.all([
        apiClient.adminGetUserUsage(account.id),
        apiClient.adminGetSubscription(account.id),
      ]);
      setUsage(nextUsage);
      setSubscription(nextSubscription);
      setEditingPlan(pricing?.plans?.[nextSubscription.subscription.plan]
        ? nextSubscription.subscription.plan
        : Object.keys(pricing?.plans ?? {})[0] ?? nextSubscription.subscription.plan);
      setEditingAddOns(nextSubscription.subscription.add_ons);
    } catch {
      setError(`The contract for ${account.username} could not be read.`);
    }
  };

  const saveSubscription = async () => {
    if (!inspecting) return;
    setContractBusy(true); setError(null); setNotice(null);
    try {
      const result = await apiClient.adminUpdateSubscription(inspecting.id, {
        plan: editingPlan,
        add_ons: Object.fromEntries(Object.entries(editingAddOns).filter(([, quantity]) => quantity > 0)),
        reason: changeReason,
        ...(changeDetail.trim() ? { detail: changeDetail.trim() } : {}),
      });
      setSubscription(result);
      setInspecting(result.user);
      setEditingPlan(result.subscription.plan);
      setEditingAddOns(result.subscription.add_ons);
      setNotice(result.changed
        ? `${result.user.username} now uses ${result.subscription.plan}; the account was notified.`
        : 'No contract values changed, so no notification was sent.');
      if (result.user.id === self?.id) await apiClient.getPricingToken();
      await load();
    } catch {
      setError('The active iPricing or an institutional identity rule refused this subscription.');
    } finally { setContractBusy(false); }
  };

  const inspectRegistration = async (registration: EngineRegistrationRevision) => {
    setReviewing(registration);
    setReviewReport(null);
    setError(null);
    try {
      setReviewReport(await apiClient.getEngineRegistrationReport(registration));
    } catch {
      setError('The submitted Engine, OpenAPI document and verification report could not be read.');
    }
  };

  return (
    <div className="admin-page">
      <div className="container">
        <header className="page-header">
          <span className="admin-kicker">Operator console</span>
          <h1>Administration</h1>
          <p className="page-description">
            Accounts, plans and keys. Passwords and email addresses are deliberately not here:
            they are how somebody signs in, and changing them would be taking an account over.
          </p>
        </header>

        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="success">{notice}</Alert>}

        <AdminOperations />

        <div className="admin-controls">
          <label className="admin-search">
            <span>Filter accounts</span>
            <input
              type="search"
              name="account-search"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search by username or email…"
              value={search}
              onChange={(e) => {
                setOffset(0);
                setSearch(e.target.value);
              }}
            />
          </label>
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
                      <Badge>{account.plan}</Badge>
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
                        Contract
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
            <div>
              <h2>Engine publication requests</h2>
              <p className="admin-note">Only registrations their owners explicitly submitted appear here. Private and rejected registrations are not discoverable by administrators.</p>
            </div>
          </div>

          {registrations.length === 0 ? (
            <p className="admin-empty">Nothing is waiting for publication review.</p>
          ) : (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Registration</th>
                  <th>Version</th>
                  <th>Digest</th>
                  <th>Status</th>
                  <th>Owner use</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {registrations.map((registration) => <tr key={bimResourceKey(registration)}>
                    <td>
                      <div className="admin-identity">
                        <strong>{registration.namespace}/{registration.name}</strong>
                        <span>EngineRegistration</span>
                      </div>
                    </td>
                    <td><code>{registration.version}</code></td>
                    <td><code title={registration.digest}>{registration.digest.slice(0, 18)}…</code></td>
                    <td>
                      <Badge variant="warning">
                        {registration.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td><Badge variant={registration.active ? 'success' : 'default'}>{registration.active ? 'active' : 'inactive'}</Badge></td>
                    <td className="admin-actions">
                      <Button size="sm" variant="ghost" onClick={() => void inspectRegistration(registration)}>Review contract</Button>
                      <Button
                        size="sm"
                        title="Verify the live pinned contract again, then publish this exact revision"
                        onClick={() => void act(
                          () => apiClient.adminApproveEngineRegistration(registration),
                          `${registration.namespace}/${registration.name}@${registration.version} is published.`
                        )}
                      >Approve publication</Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          if (window.confirm(`Reject publication of ${registration.namespace}/${registration.name}? The registration will become private to its owner again.`)) {
                            void act(
                              () => apiClient.adminRejectEngineRegistration(registration),
                              `${registration.namespace}/${registration.name}@${registration.version} was rejected and is private again.`
                            );
                          }
                        }}
                      >Reject</Button>
                    </td>
                  </tr>)}
              </tbody>
            </table>
          )}

          {reviewing && <section className="admin-registration-report" aria-live="polite">
            <header>
              <div><span>Publication contract</span><h3>{reviewing.namespace}/{reviewing.name}@{reviewing.version}</h3></div>
              <Button size="sm" variant="ghost" onClick={() => { setReviewing(null); setReviewReport(null); }}>Close</Button>
            </header>
            {!reviewReport ? <p>Loading the submitted contract…</p> : <>
              <dl>
                <div><dt>Registration digest</dt><dd><code>{reviewReport.digest}</code></dd></div>
                <div><dt>OpenAPI digest</dt><dd><code>{reviewReport.openapiDigest || 'not verified'}</code></dd></div>
                <div><dt>Verification</dt><dd><code>{String(reviewReport.report?.status || 'pending')}</code></dd></div>
              </dl>
              <details><summary>Verification report</summary><pre>{JSON.stringify(reviewReport.report, null, 2)}</pre></details>
              <details><summary>Submitted Engine</summary><pre>{JSON.stringify(reviewReport.engine, null, 2)}</pre></details>
              <details><summary>Submitted OpenAPI</summary><pre>{JSON.stringify(reviewReport.openapi, null, 2)}</pre></details>
            </>}
          </section>}
        </Card>

        {inspecting && (
          <Card padding="lg" className="admin-usage">
            <div className="admin-usage-head">
              <div><span className="admin-contract-kicker">Contract & consumption</span><h2>{inspecting.username}</h2></div>
              <Button size="sm" variant="ghost" onClick={() => setInspecting(null)}>
                Close
              </Button>
            </div>

            {usage && subscription ? (
              <>
                <div className="admin-contract-layout">
                  <form className="admin-contract-form" onSubmit={(event) => { event.preventDefault(); void saveSubscription(); }}>
                    <label>Plan<select value={editingPlan} disabled={!pricing} onChange={(event) => {
                      const plan = event.target.value;
                      setEditingPlan(plan);
                      setEditingAddOns((current) => Object.fromEntries(
                        Object.entries(current).filter(([id]) => pricing?.addOns?.[id]?.availableFor.includes(plan)),
                      ));
                    }}>
                      {!planOptions.length && <option value="">Active iPricing unavailable</option>}
                      {planOptions.map(([id, plan]) => <option key={id} value={id} disabled={id === 'RESEARCH' && !inspecting.cas_verified}>{plan.name}{id === 'RESEARCH' && !inspecting.cas_verified ? ' · requires institutional identity' : ''}</option>)}
                    </select></label>
                    <fieldset><legend>Add-ons</legend>{addOnOptions.length ? addOnOptions.map(([id, addOn]) => {
                      const { minQuantity, maxQuantity, quantityStep } = addOn.subscriptionConstraints;
                      return <label key={id}>{addOn.name}<small>{addOn.description}</small><span><input aria-label={`${addOn.name} quantity`} type="number" min="0" max={maxQuantity} step={quantityStep} value={editingAddOns[id] ?? 0} onChange={(event) => setEditingAddOns((current) => ({ ...current, [id]: Number(event.target.value) }))} /><small>{minQuantity}–{maxQuantity} · step {quantityStep} · {addOn.unit}</small></span>{Boolean(addOn.dependsOn?.length) && <small>Requires {addOn.dependsOn!.join(', ')}</small>}{Boolean(addOn.excludes?.length) && <small>Excludes {addOn.excludes!.join(', ')}</small>}</label>;
                    }) : <p>No add-ons are available for this plan.</p>}</fieldset>
                    {subscriptionIssues.length > 0 && <ul className="admin-contract-issues">{subscriptionIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                    <label>Reason<select value={changeReason} onChange={(event) => setChangeReason(event.target.value as ContractChangeReason)}><option value="administrative_decision">Administrative decision</option><option value="institutional_agreement">Institutional agreement</option><option value="new_feature">New functionality</option><option value="retirement_or_discount">Retirement or discount</option></select></label>
                    <label>Context <small>Included in the audit event and account notification</small><textarea rows={3} maxLength={1000} value={changeDetail} onChange={(event) => setChangeDetail(event.target.value)} /></label>
                    <div className="admin-contract-meta"><span>Pricing {subscription.subscription.pricing_version}</span><span>Renews {subscription.subscription.renews_at ? new Date(subscription.subscription.renews_at).toLocaleString() : 'on demand'}</span></div>
                    <Button type="submit" size="sm" disabled={contractBusy || subscriptionIssues.length > 0}>{contractBusy ? 'Updating…' : 'Update contract'}</Button>
                  </form>
                  <div className="admin-contract-summary"><strong>Current contract</strong><dl><div><dt>Plan</dt><dd>{subscription.subscription.plan}</dd></div>{Object.entries(subscription.subscription.add_ons).map(([name, quantity]) => <div key={name}><dt>{name}</dt><dd>× {quantity}</dd></div>)}<div><dt>US identity</dt><dd>{inspecting.cas_verified ? 'verified' : 'not linked'}</dd></div></dl><p>Changing LIVE pricing affects new contracts. This account remains pinned until renewal or an explicit novation here.</p></div>
                </div>
                <div className="admin-quotas">
                  {Object.values(usage.limits)
                    .filter((limit) => limit.limit > 0)
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
              <p className="admin-note">Reading the contract…</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
