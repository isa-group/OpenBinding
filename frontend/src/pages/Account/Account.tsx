import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiClient, bimResourceKey } from '../../api/client';
import type {
  ApiKeyPermission,
  ApiKeySummary,
  CreatedApiKey,
  UsageView,
} from '../../api/auth';
import type { EngineCatalogEntry, JobHistory, JobStatus } from '../../api/client';
import { PricingUnavailableError } from '../../api/auth';
import { useAuth } from '../../contexts/auth';
import { QuotaBar } from '../../components/QuotaBar';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { AccountServices } from './AccountServices';
import './Account.css';

interface PermissionOption {
  value: ApiKeyPermission;
  label: string;
  description: string;
  group: 'Read' | 'Write' | 'Sensitive';
  adminOnly?: boolean;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: 'account:read', label: 'Read account', description: 'Profile, plan, usage and pricing token.', group: 'Read' },
  { value: 'keys:read', label: 'Read API keys', description: 'Names, prefixes and grants; never secrets.', group: 'Read' },
  { value: 'instances:read', label: 'Read instances', description: 'Owned snapshots, source packages and IR.', group: 'Read' },
  { value: 'jobs:read', label: 'Read jobs', description: 'Owned jobs for the permitted Engines.', group: 'Read' },
  { value: 'engines:read', label: 'Read Engines', description: 'Catalog and deployment reports, filtered by Engine.', group: 'Read' },
  { value: 'organizations:read', label: 'Read organizations', description: 'Organization trees, memberships and projects.', group: 'Read' },
  { value: 'projects:read', label: 'Read projects', description: 'Cases, collections and immutable revisions.', group: 'Read' },
  { value: 'studies:read', label: 'Read studies', description: 'Study definitions, runs, cells and analytics.', group: 'Read' },
  { value: 'reports:read', label: 'Read reports', description: 'Draft and frozen project reports.', group: 'Read' },
  { value: 'artifacts:read', label: 'Read artifacts', description: 'Authorized reproducibility artifacts.', group: 'Read' },
  { value: 'notifications:read', label: 'Read notifications', description: 'The account inbox and delivery state.', group: 'Read' },
  { value: 'pricing:read', label: 'Read pricing status', description: 'Active public pricing metadata.', group: 'Read' },
  { value: 'account:write', label: 'Write account', description: 'Change the account profile with its password.', group: 'Write' },
  { value: 'keys:write', label: 'Manage API keys', description: 'Create attenuated keys and revoke owned keys.', group: 'Write' },
  { value: 'instances:write', label: 'Write instances', description: 'Create owned instance snapshots.', group: 'Write' },
  { value: 'instances:analyze', label: 'Analyze instances', description: 'Analyze against only the permitted Engines.', group: 'Write' },
  { value: 'engines:execute', label: 'Execute Engines', description: 'Submit solves to only the permitted Engines.', group: 'Write' },
  { value: 'engines:register', label: 'Register Engines', description: 'Create Engines and manage private deployments.', group: 'Sensitive' },
  { value: 'engines:publish', label: 'Request publication', description: 'Submit owned Engine deployments for review.', group: 'Sensitive' },
  { value: 'organizations:write', label: 'Manage organizations', description: 'Hierarchy, membership and invitations within the key boundary.', group: 'Write' },
  { value: 'projects:write', label: 'Manage projects', description: 'Create cases, collections and revisions.', group: 'Write' },
  { value: 'studies:write', label: 'Run studies', description: 'Create matrices, dispatch runs, cancel and retry cells.', group: 'Write' },
  { value: 'reports:write', label: 'Publish reports', description: 'Create, freeze and publish reproducible reports.', group: 'Write' },
  { value: 'artifacts:write', label: 'Manage artifacts', description: 'Create and expire project artifacts.', group: 'Write' },
  { value: 'extensions:register', label: 'Register extensions', description: 'Register Dialects and BIM resources.', group: 'Sensitive' },
  { value: 'engines:moderate', label: 'Moderate Engines', description: 'Review Engine publication requests.', group: 'Sensitive', adminOnly: true },
  { value: 'extensions:moderate', label: 'Moderate extensions', description: 'Approve Dialects and BIM resources.', group: 'Sensitive', adminOnly: true },
  { value: 'admin:accounts:read', label: 'Read accounts', description: 'Administrator account and usage views.', group: 'Sensitive', adminOnly: true },
  { value: 'admin:accounts:write', label: 'Administer accounts', description: 'Roles, plans, revocation and usage repair.', group: 'Sensitive', adminOnly: true },
  { value: 'pricing:admin', label: 'Administer pricing', description: 'SPHERE and SPACE pricing lifecycle actions.', group: 'Sensitive', adminOnly: true },
];

const ENGINE_LIMITED_PERMISSIONS = new Set<ApiKeyPermission>([
  'engines:read',
  'engines:execute',
  'engines:register',
  'engines:publish',
  'engines:moderate',
  'instances:analyze',
  'jobs:read',
]);

export function Account() {
  const { user, refresh } = useAuth();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [minted, setMinted] = useState<CreatedApiKey | null>(null);
  const [keyName, setKeyName] = useState('');
  const [permissions, setPermissions] = useState<ApiKeyPermission[]>([]);
  const [engines, setEngines] = useState<EngineCatalogEntry[]>([]);
  const [allEngines, setAllEngines] = useState(false);
  const [selectedEngines, setSelectedEngines] = useState<string[]>([]);
  const [methods, setMethods] = useState<Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>>([]);
  const [boundaryOrganizations, setBoundaryOrganizations] = useState('');
  const [boundaryProjects, setBoundaryProjects] = useState('');
  const [boundaryKinds, setBoundaryKinds] = useState('');
  const [boundarySlugs, setBoundarySlugs] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
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

  const loadEngines = useCallback(async () => {
    try {
      setEngines(await apiClient.getEngines());
    } catch {
      setEngines([]);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
    void loadKeys();
    void loadEngines();
    void loadHistory();
  }, [loadUsage, loadKeys, loadEngines, loadHistory]);

  const togglePermission = (permission: ApiKeyPermission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((candidate) => candidate !== permission)
        : [...current, permission]
    );
  };

  const toggleEngine = (engine: EngineCatalogEntry) => {
    const key = bimResourceKey(engine.ref);
    setSelectedEngines((current) =>
      current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]
    );
  };

  const createKey = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (permissions.length === 0) {
      setError('Choose at least one permission for this key.');
      return;
    }
    const needsEngines = permissions.some((permission) => ENGINE_LIMITED_PERMISSIONS.has(permission));
    if (needsEngines && !allEngines && selectedEngines.length === 0) {
      setError('Choose at least one exact Engine, or grant access to all Engines.');
      return;
    }
    try {
      const split = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
      const organizations = split(boundaryOrganizations);
      const projects = split(boundaryProjects);
      const resourceKinds = split(boundaryKinds);
      const slugs = split(boundarySlugs);
      const hasBoundary = methods.length + organizations.length + projects.length + resourceKinds.length + slugs.length > 0;
      const created = await apiClient.createApiKey({
        name: keyName.trim() || 'Untitled key',
        permissions,
        engine_access: {
          all: allEngines,
          engines: allEngines
            ? []
            : engines
                .filter((engine) => selectedEngines.includes(bimResourceKey(engine.ref)))
                .map((engine) => engine.ref),
        },
        ...(hasBoundary ? { boundary: {
          ...(methods.length ? { methods } : {}),
          ...(organizations.length ? { organizations } : {}),
          ...(projects.length ? { projects } : {}),
          ...(resourceKinds.length ? { resource_kinds: resourceKinds } : {}),
          ...(slugs.length ? { slugs } : {}),
        } } : {}),
        ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString() } : {}),
      });
      setMinted(created);
      setKeyName('');
      setPermissions([]);
      setAllEngines(false);
      setSelectedEngines([]);
      setMethods([]);
      setBoundaryOrganizations('');
      setBoundaryProjects('');
      setBoundaryKinds('');
      setBoundarySlugs('');
      setExpiresAt('');
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

  const rotateKey = async (keyId: string) => {
    setError(null);
    setNotice(null);
    try {
      setMinted(await apiClient.rotateApiKey(keyId));
      await loadKeys();
      setNotice('Key rotated. Copy the replacement now; the previous secret no longer works.');
    } catch {
      setError('That key could not be rotated.');
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
        <header className="page-header">
          <span className="account-kicker">Account contract</span>
          <h1>Your account</h1>
          <p className="page-description">
            Sessions control the whole account. Each API key below receives only the permissions
            and exact Engine revisions you choose for it.
          </p>
        </header>

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
                <Badge>{user.plan}</Badge>
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
                  {Object.values(usage.limits)
                    .filter((limit) => limit.limit > 0)
                    .map((limit) => (
                      <QuotaBar key={limit.limit_id} limit={limit} />
                    ))}
                </div>

                <h3 className="account-subheading">Capabilities</h3>
                <dl className="account-facts account-caps">
                  {Object.entries(usage.capabilities).map(([identifier, value]) => (
                    <Fragment key={identifier}>
                      <dt>{identifier}</dt>
                      <dd>{value === null ? 'Unlimited' : value.toLocaleString()}</dd>
                    </Fragment>
                  ))}
                </dl>
                <p className="account-note">
                  These identifiers and values come directly from your SPACE entitlement.
                </p>
              </>
            )}
          </Card>
        </div>

        <AccountServices user={user} refresh={refresh} />

        <Card padding="lg" className="account-keys">
          <h2>API keys</h2>
          <p className="account-note">
            Grants are immutable: revoke and replace a key to change them. Active keys:{' '}
            <strong>
              {keys.length} / {usage?.limits.apiKeys?.limit ?? usage?.capabilities.apiKeys ?? 'Unlimited'}
            </strong>
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
            <label className="account-key-name">
              <span>Name</span>
              <input
                aria-label="What this key is for"
                name="key-name"
                autoComplete="off"
                placeholder="CI deployment key…"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                maxLength={128}
              />
            </label>

            <div className="account-permission-groups">
              {(['Read', 'Write', 'Sensitive'] as const).map((group) => (
                <fieldset key={group} className="account-permission-group">
                  <legend>{group}</legend>
                  {PERMISSION_OPTIONS.filter(
                    (option) => option.group === group && (!option.adminOnly || user.role === 'admin')
                  ).map((option) => (
                    <label key={option.value} className="account-permission-option">
                      <input
                        type="checkbox"
                        checked={permissions.includes(option.value)}
                        onChange={() => togglePermission(option.value)}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>

            <fieldset className="account-engine-access">
              <legend>Engine access</legend>
              <label className="account-radio-option">
                <input
                  type="radio"
                  name="engine-access"
                  checked={allEngines}
                  onChange={() => setAllEngines(true)}
                />
                <span>
                  <strong>All Engines</strong>
                  <small>Includes Engines that become visible in the future.</small>
                </span>
              </label>
              <label className="account-radio-option">
                <input
                  type="radio"
                  name="engine-access"
                  checked={!allEngines}
                  onChange={() => setAllEngines(false)}
                />
                <span>
                  <strong>Selected revisions</strong>
                  <small>{selectedEngines.length} exact revision{selectedEngines.length === 1 ? '' : 's'} selected.</small>
                </span>
              </label>
              {!allEngines && (
                <div className="account-engine-list">
                  {engines.length === 0 ? (
                    <p className="account-empty">No visible Engines are available to select.</p>
                  ) : (
                    engines.map((engine) => {
                      const key = bimResourceKey(engine.ref);
                      return (
                        <label key={key} className="account-engine-option">
                          <input
                            type="checkbox"
                            checked={selectedEngines.includes(key)}
                            onChange={() => toggleEngine(engine)}
                          />
                          <span>
                            <strong>{engine.namespace}/{engine.name}</strong>
                            <code>{engine.version} · {engine.digest.slice(0, 18)}…</code>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </fieldset>

            <details className="account-key-boundary">
              <summary>Optional request boundary</summary>
              <p>A boundary can only reduce these grants. Comma-separated values match exact organization/project IDs or slugs; leave a field empty for no additional restriction.</p>
              <fieldset><legend>HTTP methods</legend><div>{(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => <label key={method}><input type="checkbox" checked={methods.includes(method)} onChange={() => setMethods((current) => current.includes(method) ? current.filter((item) => item !== method) : [...current, method])} />{method}</label>)}</div></fieldset>
              <div className="account-boundary-grid">
                <label>Organizations<input value={boundaryOrganizations} onChange={(event) => setBoundaryOrganizations(event.target.value)} placeholder="research-lab, platform-team" /></label>
                <label>Projects<input value={boundaryProjects} onChange={(event) => setBoundaryProjects(event.target.value)} placeholder="benchmark-suite" /></label>
                <label>Resource kinds<input value={boundaryKinds} onChange={(event) => setBoundaryKinds(event.target.value)} placeholder="case, study, report" /></label>
                <label>Slugs<input value={boundarySlugs} onChange={(event) => setBoundarySlugs(event.target.value)} placeholder="latency-study" /></label>
                <label>Expires at<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label>
              </div>
            </details>

            <div className="account-key-submit">
              <span>{permissions.length} permission{permissions.length === 1 ? '' : 's'} selected</span>
              <Button type="submit" size="sm">
                Create key
              </Button>
            </div>
          </form>

          {keys.length === 0 ? (
            <p className="account-empty">No keys yet.</p>
          ) : (
            <table className="account-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Permissions</th>
                  <th>Engines</th>
                  <th>Boundary</th>
                  <th>Created</th>
                  <th>Expires</th>
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
                    <td>
                      <div className="account-key-grants">
                        {key.permissions.map((permission) => (
                          <code key={permission}>{permission}</code>
                        ))}
                      </div>
                    </td>
                    <td>
                      {key.engine_access.all
                        ? 'All'
                        : `${key.engine_access.engines.length} selected`}
                    </td>
                    <td>{key.boundary && Object.keys(key.boundary).length ? <div className="account-key-grants">{Object.entries(key.boundary).flatMap(([kind, values]) => (values ?? []).map((value) => <code key={`${kind}-${value}`}>{kind}:{value}</code>))}</div> : 'Unrestricted'}</td>
                    <td>{new Date(key.created_at).toLocaleDateString()}</td>
                    <td>{key.expires_at ? new Date(key.expires_at).toLocaleString('en-GB') : 'never'}</td>
                    <td>
                      {key.last_used_at
                        ? new Date(key.last_used_at).toLocaleDateString()
                        : 'never'}
                    </td>
                    <td>
                      <span className="account-actions">
                        <Button size="sm" variant="ghost" onClick={() => void rotateKey(key.id)}>Rotate</Button>
                        <Button size="sm" variant="ghost" onClick={() => void revokeKey(key.id)}>Revoke</Button>
                      </span>
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
              <Link to="/playground" viewTransition>Playground</Link> and it will appear here.
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
                      {job.termination ? (
                        <>
                          {job.termination.toLowerCase()}
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
 * The history row says a solve happened and how it terminated; this says
 * what it actually decided. Only the canonical numbers are shown - the binding,
 * the objective and the aggregated features - because those are the ones the
 * gateway computed itself and stands behind. Anything else a caller wants is in
 * the downloaded document.
 */
function SolutionPanel({ job, onDownload }: { job: JobStatus; onDownload: () => void }) {
  const solution = job.result?.solutions?.[0];
  const binding = solution?.decision.binding ?? null;
  const objective = solution?.objectives.score;
  const metrics = solution?.metrics;

  if (!solution) {
    return (
      <p className="account-empty">
        This solve finished without producing a binding
        {job.result?.termination === 'INFEASIBLE'
          ? ': no assignment satisfies every constraint.'
          : '.'}
      </p>
    );
  }

  return (
    <div className="account-solution">
      <div className="account-solution-head">
        <span>
          {job.result?.termination && (
            <Badge
              variant={
                job.result.termination === 'OPTIMAL' || job.result.termination === 'FEASIBLE'
                  ? 'success'
                  : job.result.termination === 'INFEASIBLE'
                  ? 'error'
                  : 'warning'
              }
            >
              {job.result.termination.toLowerCase()}
            </Badge>
          )}
          {objective != null && (
            <span className="account-solution-objective">
              objective{' '}
              <strong>
                {typeof objective === 'number'
                  ? objective.toLocaleString('en-GB', { maximumFractionDigits: 4 })
                  : `[${objective.map((value) => value.toLocaleString('en-GB', { maximumFractionDigits: 4 })).join(', ')}]`}
              </strong>
            </span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={onDownload}>
          Download JSON
        </Button>
      </div>

      {metrics && Object.keys(metrics).length > 0 && (
        <p className="account-solution-features">
          {Object.entries(metrics).map(([name, value]) => (
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
                  <code>{candidate.resource}:{candidate.id}</code>
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
