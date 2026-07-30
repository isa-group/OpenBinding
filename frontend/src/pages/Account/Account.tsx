import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { apiClient } from '../../api/client';
import type { ApiKeySummary, CreatedApiKey, UsageView } from '../../api/auth';
import type { JobHistory, JobStatus } from '../../api/client';
import { PricingUnavailableError } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';
import { QuotaBar, isBalance } from '../../components/QuotaBar';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import './Account.css';

export function Account() {
  const { user, refresh } = useAuth();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [minted, setMinted] = useState<CreatedApiKey | null>(null);
  const [keyName, setKeyName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<JobHistory | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [solutions, setSolutions] = useState<Record<string, JobStatus>>({});
  const [loadingSolution, setLoadingSolution] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await apiClient.listOwnJobs({ limit: 20 }));
    } catch {
      // A history nobody can read is not worth an error banner over the rest
      // of the page; the section simply says nothing.
      setHistory(null);
    }
  }, []);

  const download = (contents: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(contents, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const downloadRequest = async (jobId: string, engineId: string) => {
    // What a retention window is *for*: being able to run a past solve again,
    // or compare another engine against it. Downloaded rather than shown,
    // because an instance is a document you feed back in, not one you read.
    try {
      const kept = await apiClient.getJobRequest(jobId);
      download(kept.instance, `${engineId}-${jobId.slice(0, 8)}.instance.json`);
    } catch {
      setError(
        'That solve did not record what it was asked. Jobs from before the gateway ' +
          'started keeping instances cannot be reproduced.'
      );
    }
  };

  const toggleSolution = async (jobId: string) => {
    // The other half of a retention window. Keeping the question and throwing
    // away the answer makes a history that records that something was solved
    // without recording what it decided - so the binding is shown here rather
    // than only downloaded, because unlike an instance it is meant to be read.
    if (openJob === jobId) {
      setOpenJob(null);
      return;
    }

    setOpenJob(jobId);
    if (solutions[jobId]) return;

    setLoadingSolution(jobId);
    try {
      const job = await apiClient.getJobStatus(jobId);
      setSolutions((current) => ({ ...current, [jobId]: job }));
    } catch {
      setOpenJob(null);
      setError(
        'That solve could not be retrieved. It may have aged out of the window ' +
          'your plan keeps, or the gateway is not reachable.'
      );
    } finally {
      setLoadingSolution(null);
    }
  };

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await apiClient.getOwnUsage());
      setUsageError(null);
    } catch (err) {
      // The account may be perfectly healthy; the pricing service is not.
      setUsageError(
        err instanceof PricingUnavailableError
          ? 'Quotas cannot be read right now. Solving may be on hold until the pricing service is back.'
          : 'Quotas could not be loaded.'
      );
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await apiClient.listApiKeys());
    } catch {
      setError('Your API keys could not be loaded.');
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    void loadKeys();
    void loadHistory();
  }, [loadUsage, loadKeys, loadHistory]);

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await apiClient.createApiKey(keyName.trim() || 'Untitled key');
      setMinted(created);
      setKeyName('');
      await loadKeys();
      await loadUsage();
    } catch {
      setError('The key could not be created. You may have reached your plan’s limit.');
    }
  };

  const revokeKey = async (keyId: string) => {
    setError(null);
    try {
      await apiClient.revokeApiKey(keyId);
      if (minted?.id === keyId) setMinted(null);
      await loadKeys();
      await loadUsage();
    } catch {
      setError('That key could not be revoked.');
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setNotice('Key copied to the clipboard.');
    } catch {
      setNotice('Select the key and copy it manually.');
    }
  };

  if (!user) return null;

  return (
    <div className="account-page">
      <div className="container">
        <div className="page-header">
          <h1>Your account</h1>
          <p className="page-description">
            Everything here is a documented endpoint of the gateway API, so anything this page
            does, a script with an API key can do too.
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="info">{notice}</Alert>}

        <div className="account-grid">
          <Card padding="lg">
            <h2>Profile</h2>
            <dl className="account-facts">
              <dt>Username</dt>
              <dd>{user.username}</dd>
              <dt>Email</dt>
              <dd>{user.email}</dd>
              <dt>Plan</dt>
              <dd>
                <Badge variant={user.plan === 'PRO' ? 'accent' : 'default'}>{user.plan}</Badge>
                {usage?.contract_pending && (
                  <span className="account-pending">
                    {' '}
                    contract pending &mdash; it will be settled automatically
                  </span>
                )}
              </dd>
              {user.role === 'admin' && (
                <>
                  <dt>Role</dt>
                  <dd>
                    <Badge variant="accent">Administrator</Badge>
                  </dd>
                </>
              )}
            </dl>
            <p className="account-note">
              Moving between plans is done by an administrator: there is no payment gateway.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void refresh()}>
              Refresh
            </Button>
          </Card>

          <Card padding="lg">
            <h2>Allowances</h2>
            {usageError && <Alert type="warning">{usageError}</Alert>}
            {usage && (
              <>
                <div className="account-quotas">
                  {usage.limits
                    .filter((limit) => isBalance(limit.limit_id) && limit.limit > 0)
                    .map((limit) => (
                      <QuotaBar key={limit.limit_id} limit={limit} />
                    ))}
                </div>

                <h3 className="account-subheading">Per request</h3>
                <dl className="account-facts account-caps">
                  <dt>Longest solver budget</dt>
                  <dd>{usage.caps.max_timeout_s} s</dd>
                  <dt>Largest instance</dt>
                  <dd>{usage.caps.max_payload_mb} MB</dd>
                  <dt>Largest binding space</dt>
                  <dd>10^{usage.caps.max_binding_space_log10}</dd>
                  <dt>Search effort ceiling</dt>
                  <dd>{usage.caps.max_iterations.toLocaleString()} iterations</dd>
                </dl>
                <p className="account-note">
                  A request asking for more than these is reduced to them rather than refused,
                  and the reduction is reported with the result.
                </p>
              </>
            )}
          </Card>
        </div>

        <Card padding="lg" className="account-keys">
          <h2>API keys</h2>
          <p className="account-note">
            A key reaches the same account this page does, so it draws on the same allowances.
          </p>

          {minted && (
            <Alert type="success" title="Copy this key now">
              <p>It is shown once. What is stored is a hash, so it cannot be shown again.</p>
              <code className="account-secret">{minted.secret}</code>
              <Button size="sm" variant="secondary" onClick={() => void copySecret(minted.secret)}>
                Copy
              </Button>
            </Alert>
          )}

          <form className="account-key-form" onSubmit={createKey}>
            <input
              aria-label="What this key is for"
              placeholder="What is this key for?"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              maxLength={128}
            />
            <Button type="submit" size="sm">
              Create key
            </Button>
          </form>

          {keys.length === 0 ? (
            <p className="account-empty">No keys yet.</p>
          ) : (
            <table className="account-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.prefix}</code>
                    </td>
                    <td>{new Date(key.created_at).toLocaleDateString()}</td>
                    <td>
                      {key.last_used_at
                        ? new Date(key.last_used_at).toLocaleDateString()
                        : 'never'}
                    </td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => void revokeKey(key.id)}>
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card padding="lg" className="account-history">
          <h2>Recent solves</h2>
          <p className="account-note">
            {history
              ? `Your last ${history.total} solve${history.total === 1 ? '' : 's'}, kept for ${history.retention_days} days on this plan.`
              : 'What this account has asked for, as far back as the plan keeps it.'}
          </p>

          {!history || history.jobs.length === 0 ? (
            <p className="account-empty">
              Nothing yet. Solve something in the{' '}
              <a href="/playground">Playground</a> and it will appear here.
            </p>
          ) : (
            <table className="account-table">
              <thead>
                <tr>
                  <th>Engine</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.jobs.map((job) => (
                  <Fragment key={job.id}>
                  <tr>
                    <td>
                      <code>{job.engine_id}</code>
                    </td>
                    <td>
                      <Badge
                        variant={
                          job.status === 'completed'
                            ? 'success'
                            : job.status === 'failed'
                            ? 'error'
                            : 'default'
                        }
                      >
                        {job.status}
                      </Badge>
                    </td>
                    <td>
                      {job.feasibility ? (
                        <>
                          {job.feasibility.toLowerCase()}
                          {job.solutions != null && `, ${job.solutions} solution${job.solutions === 1 ? '' : 's'}`}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{new Date(job.created_at).toLocaleString('en-GB')}</td>
                    <td className="account-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Download the instance and options this solve was given"
                        onClick={() => void downloadRequest(job.id, job.engine_id)}
                      >
                        Request
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={job.status !== 'completed' || loadingSolution === job.id}
                        title={
                          job.status === 'completed'
                            ? 'Show the binding this solve produced'
                            : `This solve ${job.status === 'failed' ? 'failed' : 'has not finished'}, so there is no solution to show`
                        }
                        onClick={() => void toggleSolution(job.id)}
                      >
                        {loadingSolution === job.id
                          ? 'Loading…'
                          : openJob === job.id
                          ? 'Hide'
                          : 'Solution'}
                      </Button>
                    </td>
                  </tr>
                  {openJob === job.id && solutions[job.id] && (
                    <tr className="account-solution-row">
                      <td colSpan={5}>
                        <SolutionPanel
                          job={solutions[job.id]}
                          onDownload={() =>
                            download(
                              solutions[job.id].result,
                              `${job.engine_id}-${job.id.slice(0, 8)}.solution.json`
                            )
                          }
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * A finished solve, as the reference evaluator scored it.
 *
 * The history row says a solve happened and whether it was feasible; this says
 * what it actually decided. Only the canonical numbers are shown - the binding,
 * the objective and the aggregated features - because those are the ones the
 * gateway computed itself and stands behind. Anything else a caller wants is in
 * the downloaded document.
 */
function SolutionPanel({ job, onDownload }: { job: JobStatus; onDownload: () => void }) {
  const solution = job.result?.solutions?.[0];
  const binding = (solution?.binding ?? null) as Record<string, string> | null;
  const objective = solution?.objective_value;
  const features = solution?.aggregated_features as Record<string, number> | undefined;

  if (!solution) {
    return (
      <p className="account-empty">
        This solve finished without producing a binding
        {job.result?.feasibility === 'INFEASIBLE'
          ? ': no assignment satisfies every constraint.'
          : '.'}
      </p>
    );
  }

  return (
    <div className="account-solution">
      <div className="account-solution-head">
        <span>
          {job.result?.feasibility && (
            <Badge variant={job.result.feasibility === 'FEASIBLE' ? 'success' : 'error'}>
              {job.result.feasibility.toLowerCase()}
            </Badge>
          )}
          {typeof objective === 'number' && (
            <span className="account-solution-objective">
              objective <strong>{objective.toLocaleString('en-GB', { maximumFractionDigits: 4 })}</strong>
            </span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onDownload}>
          Download JSON
        </Button>
      </div>

      {features && Object.keys(features).length > 0 && (
        <p className="account-solution-features">
          {Object.entries(features).map(([name, value]) => (
            <span key={name}>
              {name} <strong>{typeof value === 'number' ? value.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : String(value)}</strong>
            </span>
          ))}
        </p>
      )}

      {binding && Object.keys(binding).length > 0 ? (
        <table className="account-binding">
          <thead>
            <tr>
              <th>Task</th>
              <th>Candidate</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(binding).map(([task, candidate]) => (
              <tr key={task}>
                <td>
                  <code>{task}</code>
                </td>
                <td>
                  <code>{String(candidate)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="account-empty">The solution carries no binding.</p>
      )}

      {(job.result?.solutions?.length ?? 0) > 1 && (
        <p className="account-note">
          Showing the first of {job.result!.solutions!.length} solutions; the rest are in the
          downloaded document.
        </p>
      )}
    </div>
  );
}
