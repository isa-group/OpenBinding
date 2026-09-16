import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  Building2,
  Check,
  Copy,
  Cpu,
  FileDown,
  Gauge,
  History,
  KeyRound,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  Sparkles,
  Trash2,
} from 'lucide-react';
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
  { value: 'instances:validate', label: 'Validate instances', description: 'Validate against only the permitted Engines.', group: 'Write' },
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

const BOUNDARY_LIMIT_IDS = new Set<string>([
  'maxInstanceComplexityLog10',
  'maxTimeoutSeconds',
  'maxIterations',
  'maxPayloadBytes',
  'jobHistoryDays',
]);

const ENGINE_LIMITED_PERMISSIONS = new Set<ApiKeyPermission>([
  'engines:read',
  'engines:execute',
  'engines:register',
  'engines:publish',
  'engines:moderate',
  'instances:validate',
  'jobs:read',
]);

type TabCategory = 'overview' | 'services' | 'keys' | 'history';

export function Account() {
  const { user, refresh } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabCategory = useMemo(() => {
    if (tabParam === 'services' || tabParam === 'keys' || tabParam === 'history') {
      return tabParam;
    }
    return 'overview';
  }, [tabParam]);

  const setActiveTab = useCallback((tab: TabCategory) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (tab === 'overview') {
        next.delete('tab');
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams]);
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
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [history, setHistory] = useState<JobHistory | null>(null);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [solutions, setSolutions] = useState<Record<string, JobStatus>>({});
  const [loadingSolution, setLoadingSolution] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [securityEmail, setSecurityEmail] = useState(user?.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityNotice, setSecurityNotice] = useState<string | null>(null);
  const [securityError, setSecurityError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.email) {
      setSecurityEmail(user.email);
    }
  }, [user?.email]);

  const handleUpdateSecurity = async (e: FormEvent) => {
    e.preventDefault();
    setSecurityError(null);
    setSecurityNotice(null);

    if (!user) return;
    const emailChanged = securityEmail.trim().toLowerCase() !== user.email.toLowerCase();
    const passwordChanging = Boolean(newPassword);

    if (!emailChanged && !passwordChanging) {
      setSecurityError('No changes were made to email or password.');
      return;
    }

    if (!currentPassword) {
      setSecurityError('Your current password is required to update credentials.');
      return;
    }

    if (passwordChanging) {
      if (newPassword !== confirmPassword) {
        setSecurityError('New password and confirm password do not match.');
        return;
      }
      if (newPassword.length < 8) {
        setSecurityError('New password must be at least 8 characters long.');
        return;
      }
    }

    setSecurityLoading(true);
    try {
      await apiClient.updateOwnProfile({
        email: emailChanged ? securityEmail.trim() : undefined,
        current_password: currentPassword,
        new_password: passwordChanging ? newPassword : undefined,
      });
      await refresh();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSecurityNotice('Security credentials successfully updated.');
    } catch (err: unknown) {
      setSecurityError(err instanceof Error ? err.message : 'Failed to update credentials.');
    } finally {
      setSecurityLoading(false);
    }
  };

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await apiClient.listOwnJobs({ limit: 20 }));
    } catch {
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

  const reloadAll = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.allSettled([
      refresh(),
      loadUsage(),
      loadKeys(),
      loadEngines(),
      loadHistory(),
    ]);
    setIsRefreshing(false);
  }, [refresh, loadUsage, loadKeys, loadEngines, loadHistory]);

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

  const copyPrefix = async (prefix: string) => {
    try {
      await navigator.clipboard.writeText(prefix);
      setCopiedKey(prefix);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Non-fatal
    }
  };

  // Compute metrics for the top-level stats bar
  const activeLimits = useMemo(() => {
    if (!usage?.limits) return [];
    return Object.values(usage.limits).filter(
      (limit) => limit.limit > 0 && !BOUNDARY_LIMIT_IDS.has(limit.limit_id)
    );
  }, [usage]);

  const maxConsumptionRate = useMemo(() => {
    if (activeLimits.length === 0) return 0;
    return Math.max(
      ...activeLimits.map((l) =>
        Math.min(100, Math.round((Math.max(0, l.used) / l.limit) * 100))
      )
    );
  }, [activeLimits]);

  const isResearch = Boolean(user && (user.plan === 'RESEARCH' || user.institutional_branding));

  if (!user) return null;

  return (
    <div className="account-page">
      <div className="container">
        {/* Modernized Executive Header */}
        <header className="account-header">
          <div className="account-header-main">
            <div className="account-breadcrumb">
              <span className="account-kicker">System / Account</span>
              {isResearch && (
                <span className="account-us-pill" title="Account verified by Universidad de Sevilla">
                  <img src="/brands/us-logo.png" alt="US" />
                  <span>Universidad de Sevilla</span>
                </span>
              )}
            </div>
            <div className="account-title-row">
              <h1>Account &amp; Security Hub</h1>
              <span className="account-role-badge">
                <Badge variant={user.role === 'admin' ? 'accent' : 'default'}>
                  {user.role === 'admin' ? 'Platform Administrator' : 'Account Member'}
                </Badge>
              </span>
            </div>
            <p className="account-description">
              Supervise your active entitlements and quotas managed by{' '}
              <a
                href="https://github.com/isa-group/space"
                target="_blank"
                rel="noopener noreferrer"
                className="account-space-link"
              >
                SPACE
              </a>
              {' '} (Smart Pricing and Access Control Engine). It manages signed contracts, entitlements, dynamic quotas, execution boundaries, and fine-grained API access. Monitor your active rights and verifiable solve history here.
            </p>
          </div>
          <div className="account-header-actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reloadAll()}
              disabled={isRefreshing}
              className="account-refresh-btn"
            >
              <RefreshCw className={isRefreshing ? 'is-spinning' : ''} aria-hidden="true" />
              <span>Refresh Status</span>
            </Button>
          </div>
        </header>

        {/* Global Notifications */}
        {error && <Alert type="error">{error}</Alert>}
        {notice && <Alert type="info">{notice}</Alert>}

        {/* Top-Level Key Metrics Summary Bar */}
        <section className="account-metrics-bar" aria-label="Account key metrics summary">
          {/* Metric 1: Active Plan */}
          <article
            className="account-metric-card"
            onClick={() => setActiveTab('overview')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab('overview')}
          >
            <header className="account-metric-header">
              <span className="account-metric-icon is-plan">
                <Shield aria-hidden="true" />
              </span>
              <span className="account-metric-label">Active Plan</span>
              <ArrowUpRight className="account-metric-arrow" aria-hidden="true" />
            </header>
            <div className="account-metric-body">
              <strong className="account-metric-value">{user.plan}</strong>
              <div className="account-metric-badges">
                {usage?.contract_pending ? (
                  <Badge variant="warning">Sync Pending</Badge>
                ) : (
                  <Badge variant="success">Active Tier</Badge>
                )}
                {user.role === 'admin' && <Badge variant="accent">Admin</Badge>}
              </div>
            </div>
            <footer className="account-metric-footer">
              <span>Managed by central administrator</span>
            </footer>
          </article>

          {/* Metric 2: Quota Consumption */}
          <article
            className="account-metric-card"
            onClick={() => setActiveTab('overview')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab('overview')}
          >
            <header className="account-metric-header">
              <span className="account-metric-icon is-quota">
                <Gauge aria-hidden="true" />
              </span>
              <span className="account-metric-label">Quota Consumption</span>
              <ArrowUpRight className="account-metric-arrow" aria-hidden="true" />
            </header>
            <div className="account-metric-body">
              <div className="account-metric-value-row">
                <strong className="account-metric-value">
                  {usageError ? 'Offline' : `${maxConsumptionRate}%`}
                </strong>
                {!usageError && (
                  <Badge variant={maxConsumptionRate >= 90 ? 'error' : maxConsumptionRate >= 75 ? 'warning' : 'success'}>
                    {maxConsumptionRate >= 90 ? 'Near Limit' : maxConsumptionRate >= 75 ? 'Moderate' : 'Healthy'}
                  </Badge>
                )}
              </div>
              <div className="account-metric-progress">
                <div
                  className={`account-metric-progress-bar ${maxConsumptionRate >= 90 ? 'is-spent' : maxConsumptionRate >= 75 ? 'is-low' : 'is-healthy'}`}
                  style={{ width: `${Math.max(4, Math.min(100, maxConsumptionRate))}%` }}
                />
              </div>
            </div>
            <footer className="account-metric-footer">
              <span>{activeLimits.length} active quotas supervised</span>
            </footer>
          </article>

          {/* Metric 3: Active API Keys */}
          <article
            className="account-metric-card"
            onClick={() => setActiveTab('keys')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab('keys')}
          >
            <header className="account-metric-header">
              <span className="account-metric-icon is-keys">
                <KeyRound aria-hidden="true" />
              </span>
              <span className="account-metric-label">Active API Keys</span>
              <ArrowUpRight className="account-metric-arrow" aria-hidden="true" />
            </header>
            <div className="account-metric-body">
              <div className="account-metric-value-row">
                <strong className="account-metric-value">{keys.length}</strong>
                <Badge variant={keys.length > 0 ? 'default' : 'info'}>
                  {keys.length === 1 ? '1 Credential' : `${keys.length} Credentials`}
                </Badge>
              </div>
              <div className="account-metric-cap">
                Limit: <code>{usage?.limits.apiKeys?.limit ?? usage?.capabilities.apiKeys ?? 'Unlimited'}</code>
              </div>
            </div>
            <footer className="account-metric-footer">
              <span>Attenuated grants &amp; boundaries</span>
            </footer>
          </article>

          {/* Metric 4: Recent Solves */}
          <article
            className="account-metric-card"
            onClick={() => setActiveTab('history')}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setActiveTab('history')}
          >
            <header className="account-metric-header">
              <span className="account-metric-icon is-history">
                <History aria-hidden="true" />
              </span>
              <span className="account-metric-label">Recent Solves</span>
              <ArrowUpRight className="account-metric-arrow" aria-hidden="true" />
            </header>
            <div className="account-metric-body">
              <div className="account-metric-value-row">
                <strong className="account-metric-value">{history?.total ?? history?.jobs.length ?? 0}</strong>
                <Badge variant="info">{history?.retention_days ?? 7}d Window</Badge>
              </div>
              <div className="account-metric-cap">
                Audit record kept for {history?.retention_days ?? 7} days
              </div>
            </div>
            <footer className="account-metric-footer">
              <span>Verifiable evaluation artifacts</span>
            </footer>
          </article>
        </section>

        {/* Organized Category Tabs Navigation */}
        <nav className="account-nav-tabs" role="tablist" aria-label="Account category sections">
          <button
            type="button"
            role="tab"
            id="tab-btn-overview"
            aria-selected={activeTab === 'overview'}
            aria-controls="tab-pane-overview"
            className={`account-tab-btn ${activeTab === 'overview' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <Gauge aria-hidden="true" />
            <span>Overview &amp; Quotas</span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-btn-services"
            aria-selected={activeTab === 'services'}
            aria-controls="tab-pane-services"
            className={`account-tab-btn ${activeTab === 'services' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('services')}
          >
            <Building2 aria-hidden="true" />
            <span>Connected Services</span>
            {isResearch && <span className="account-tab-chip">US CAS</span>}
          </button>
          <button
            type="button"
            role="tab"
            id="tab-btn-keys"
            aria-selected={activeTab === 'keys'}
            aria-controls="tab-pane-keys"
            className={`account-tab-btn ${activeTab === 'keys' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('keys')}
          >
            <KeyRound aria-hidden="true" />
            <span>API Keys</span>
            <span className="account-tab-badge">{keys.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-btn-history"
            aria-selected={activeTab === 'history'}
            aria-controls="tab-pane-history"
            className={`account-tab-btn ${activeTab === 'history' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <History aria-hidden="true" />
            <span>Execution History</span>
            <span className="account-tab-badge">{history?.total ?? history?.jobs.length ?? 0}</span>
          </button>
        </nav>

        {/* ========================================================================= */}
        {/* TAB 1: Overview & Quotas */}
        {/* ========================================================================= */}
        <section
          id="tab-pane-overview"
          role="tabpanel"
          aria-labelledby="tab-btn-overview"
          className={`account-tab-pane ${activeTab === 'overview' ? 'is-active' : 'is-inactive'}`}
        >
          <div className="account-overview-grid">
            {/* Left Card: Profile & Identity */}
            <Card padding="lg" className="account-profile-card">
              <div className="account-card-header">
                <div className="account-user-badge">
                  <span>{user.username.slice(0, 2).toUpperCase()}</span>
                </div>
                <div>
                  <h2>{user.username}</h2>
                  <p className="account-card-subtitle">{user.email}</p>
                </div>
              </div>

              {/* Institutional US Branding Badge if Applicable */}
              {isResearch && (
                <div className="account-us-institutional-card">
                  <div className="us-card-logo-wrap">
                    <img src="/brands/us-logo.png" alt="Universidad de Sevilla" />
                  </div>
                  <div className="us-card-info">
                    <div className="us-card-title">Universidad de Sevilla</div>
                    <div className="us-card-meta">
                      Academic research agreement with preferred access to features and more relaxed usage limits.
                    </div>
                  </div>
                  <Badge variant="accent">Campus US</Badge>
                </div>
              )}

              <h3 className="account-subheading">Identity Attributes</h3>
              <dl className="account-facts">
                <dt>Username</dt>
                <dd><code>{user.username}</code></dd>
                <dt>Email</dt>
                <dd>{user.email}</dd>
                <dt>Plan Tier</dt>
                <dd>
                  <Badge variant="default">{user.plan}</Badge>
                  {usage?.contract_pending && (
                    <span className="account-pending"> contract pending</span>
                  )}
                </dd>
                <dt>Access Role</dt>
                <dd>
                  {user.role === 'admin' ? (
                    <Badge variant="accent">Administrator</Badge>
                  ) : (
                    <Badge variant="default">Member</Badge>
                  )}
                </dd>
                <dt>Registered</dt>
                <dd>{new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</dd>
              </dl>

              <div className="account-profile-footer">
                <p className="account-note">
                  Plan tiers, seat quotas and capabilities are governed centrally by administrators: there is no public payment gateway.
                </p>
                <Button variant="secondary" size="sm" onClick={() => void refresh()}>
                  <RefreshCw aria-hidden="true" style={{ width: 13, height: 13 }} /> Refresh Profile
                </Button>
              </div>
            </Card>

            {/* Right Card: Allowances, Quotas & SPACE Capabilities */}
            <Card padding="lg" className="account-quotas-card">
              <div className="account-card-header">
                <div>
                  <h2>Allowances &amp; Quotas</h2>
                  <p className="account-card-subtitle">
                    Dynamic consumption limits and execution capabilities enforced by your active SPACE contract.
                  </p>
                </div>
              </div>

              {usageError && <Alert type="warning">{usageError}</Alert>}

              {usage && (
                <>
                  <div className="account-quotas">
                    {Object.values(usage.limits)
                      .filter((limit) => limit.limit > 0 && !BOUNDARY_LIMIT_IDS.has(limit.limit_id))
                      .map((limit) => (
                        <QuotaBar key={limit.limit_id} limit={limit} />
                      ))}
                    {Object.values(usage.limits).filter((limit) => limit.limit > 0 && !BOUNDARY_LIMIT_IDS.has(limit.limit_id)).length === 0 && (
                      <p className="account-empty">No consumable quota limits are currently enforced on this tier.</p>
                    )}
                  </div>

                  <h3 className="account-subheading">SPACE Entitlements &amp; Boundaries</h3>
                  <div className="account-capabilities-grid">
                    {Object.values(usage.limits)
                      .filter((limit) => BOUNDARY_LIMIT_IDS.has(limit.limit_id))
                      .map((limit) => (
                        <div key={limit.limit_id} className="capability-chip">
                          <span className="capability-name">{limit.limit_id}</span>
                          <strong className="capability-val">
                            {limit.limit.toLocaleString()}{limit.unit ? ` ${limit.unit}` : ''}
                          </strong>
                        </div>
                      ))}
                    {Object.entries(usage.capabilities).map(([identifier, value]) => (
                      <div key={identifier} className="capability-chip">
                        <span className="capability-name">{identifier}</span>
                        <strong className="capability-val">
                          {value === null ? 'Unlimited' : typeof value === 'number' ? value.toLocaleString() : String(value)}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="account-note">
                    These capacity constraints and capability flags come directly from your cryptographically signed SPACE token.
                  </p>
                </>
              )}
            </Card>

            {/* Third Card: Security & Credentials */}
            <Card padding="lg" className="account-security-card">
              <div className="account-card-header">
                <div className="account-user-badge security-badge">
                  <KeyRound aria-hidden="true" />
                </div>
                <div>
                  <h2>Security &amp; Credentials</h2>
                  <p className="account-card-subtitle">
                    Modify your primary login email address and authentication password.
                  </p>
                </div>
              </div>

              {securityError && <Alert type="error">{securityError}</Alert>}
              {securityNotice && <Alert type="success">{securityNotice}</Alert>}

              <form className="account-security-form" onSubmit={handleUpdateSecurity}>
                <div className="security-form-grid">
                  <div className="security-field">
                    <label htmlFor="sec-current-pwd">Current password <span className="field-required">*</span></label>
                    <input
                      id="sec-current-pwd"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Required to confirm changes"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                    />
                    <small className="field-hint">Required for all credential modifications.</small>
                  </div>

                  <div className="security-field">
                    <label htmlFor="sec-email">Email address</label>
                    <input
                      id="sec-email"
                      type="email"
                      autoComplete="email"
                      value={securityEmail}
                      onChange={(e) => setSecurityEmail(e.target.value)}
                      required
                    />
                    <small className="field-hint">Used for sign-in and account notifications.</small>
                  </div>

                  <div className="security-field">
                    <label htmlFor="sec-new-pwd">New password</label>
                    <input
                      id="sec-new-pwd"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Leave blank to keep unchanged"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <small className="field-hint">Minimum 8 characters.</small>
                  </div>

                  <div className="security-field">
                    <label htmlFor="sec-confirm-pwd">Confirm new password</label>
                    <input
                      id="sec-confirm-pwd"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Retype new password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                    <small className="field-hint">Must match new password above.</small>
                  </div>
                </div>

                <div className="security-form-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={securityLoading}
                  >
                    {securityLoading ? 'Updating credentials…' : 'Update Credentials'}
                  </Button>
                </div>
              </form>
            </Card>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* TAB 2: Connected Services */}
        {/* ========================================================================= */}
        <section
          id="tab-pane-services"
          role="tabpanel"
          aria-labelledby="tab-btn-services"
          className={`account-tab-pane ${activeTab === 'services' ? 'is-active' : 'is-inactive'}`}
        >
          <AccountServices user={user} refresh={refresh} />
        </section>

        {/* ========================================================================= */}
        {/* TAB 3: API Keys */}
        {/* ========================================================================= */}
        <section
          id="tab-pane-keys"
          role="tabpanel"
          aria-labelledby="tab-btn-keys"
          className={`account-tab-pane ${activeTab === 'keys' ? 'is-active' : 'is-inactive'}`}
        >
          {/* Minted Secret Alert */}
          {minted && (
            <div className="account-minted-banner">
              <div className="account-minted-header">
                <div className="account-minted-icon">
                  <Sparkles aria-hidden="true" />
                </div>
                <div>
                  <h3>New API Secret Generated</h3>
                  <p>Copy this secret key immediately. For security, only a cryptographic hash is retained on OpenBinding servers; it cannot be retrieved later.</p>
                </div>
              </div>
              <div className="account-minted-secret-box">
                <code className="account-secret">{minted.secret}</code>
                <Button size="sm" variant="secondary" onClick={() => void copySecret(minted.secret)}>
                  <Copy aria-hidden="true" /> Copy Secret
                </Button>
              </div>
            </div>
          )}

          {/* Provision Key Card */}
          <Card padding="lg" className="account-create-key-card">
            <div className="account-section-heading">
              <div>
                <h2>Provision API Key</h2>
                <p className="account-card-subtitle">
                  Generate attenuated machine tokens with scoped permissions, exact Engine revisions, and optional perimeter boundaries.
                </p>
              </div>
              <span className="account-keys-counter">
                Active keys: <strong>{keys.length} / {usage?.limits.apiKeys?.limit ?? usage?.capabilities.apiKeys ?? 'Unlimited'}</strong>
              </span>
            </div>

            <form className="account-key-form" onSubmit={createKey}>
              <div className="account-form-row">
                <label className="account-key-name">
                  <span>Key Name or Purpose</span>
                  <input
                    aria-label="What this key is for"
                    name="key-name"
                    autoComplete="off"
                    placeholder="e.g. CI benchmark runner, production ingestion agent…"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                    maxLength={128}
                  />
                </label>
              </div>

              <div className="account-permission-groups">
                {(['Read', 'Write', 'Sensitive'] as const).map((group) => (
                  <fieldset key={group} className="account-permission-group">
                    <legend>{group} Permissions</legend>
                    <div className="account-permission-options-grid">
                      {PERMISSION_OPTIONS.filter(
                        (option) => option.group === group && (!option.adminOnly || user.role === 'admin')
                      ).map((option) => (
                        <label key={option.value} className={`account-permission-option ${permissions.includes(option.value) ? 'is-selected' : ''}`}>
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
                    </div>
                  </fieldset>
                ))}
              </div>

              <fieldset className="account-engine-access">
                <legend>Engine Access Scope</legend>
                <div className="account-radio-group">
                  <label className="account-radio-option">
                    <input
                      type="radio"
                      name="engine-access"
                      checked={allEngines}
                      onChange={() => setAllEngines(true)}
                    />
                    <span>
                      <strong>All Engines</strong>
                      <small>Grants access to any existing and future registered Engines.</small>
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
                      <strong>Selected Revisions</strong>
                      <small>{selectedEngines.length} exact revision{selectedEngines.length === 1 ? '' : 's'} selected.</small>
                    </span>
                  </label>
                </div>
                {!allEngines && (
                  <div className="account-engine-list">
                    {engines.length === 0 ? (
                      <p className="account-empty">No visible Engines are available to select.</p>
                    ) : (
                      engines.map((engine) => {
                        const key = bimResourceKey(engine.ref);
                        return (
                          <label key={key} className={`account-engine-option ${selectedEngines.includes(key) ? 'is-selected' : ''}`}>
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
                <summary>Optional Request Boundary &amp; Expiration</summary>
                <p>A boundary restricts where this credential can be used. Comma-separated values match exact identifiers; leave blank for unrestricted scope.</p>
                <fieldset>
                  <legend>Permitted HTTP Methods</legend>
                  <div className="account-methods-grid">
                    {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((method) => (
                      <label key={method}>
                        <input
                          type="checkbox"
                          checked={methods.includes(method)}
                          onChange={() => setMethods((current) => current.includes(method) ? current.filter((item) => item !== method) : [...current, method])}
                        />
                        {method}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="account-boundary-grid">
                  <label>
                    Organizations
                    <input value={boundaryOrganizations} onChange={(event) => setBoundaryOrganizations(event.target.value)} placeholder="e.g. research-lab, isa-group" />
                  </label>
                  <label>
                    Projects
                    <input value={boundaryProjects} onChange={(event) => setBoundaryProjects(event.target.value)} placeholder="e.g. benchmark-suite" />
                  </label>
                  <label>
                    Resource Kinds
                    <input value={boundaryKinds} onChange={(event) => setBoundaryKinds(event.target.value)} placeholder="case, study, report" />
                  </label>
                  <label>
                    Slugs
                    <input value={boundarySlugs} onChange={(event) => setBoundarySlugs(event.target.value)} placeholder="latency-study" />
                  </label>
                  <label>
                    Expires At
                    <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
                  </label>
                </div>
              </details>

              <div className="account-key-submit">
                <span className="account-selection-count">
                  {permissions.length} permission{permissions.length === 1 ? '' : 's'} selected
                </span>
                <Button type="submit" size="sm" variant="primary">
                  <Plus aria-hidden="true" /> Create key
                </Button>
              </div>
            </form>
          </Card>

          {/* Active Keys Table Card */}
          <Card padding="lg" className="account-keys-table-card">
            <div className="account-section-heading">
              <div>
                <h2>Configured API Keys</h2>
                <p className="account-card-subtitle">Active credentials provisioned for this account with associated boundaries and usage timestamps.</p>
              </div>
              <Badge variant="default">{keys.length} Active</Badge>
            </div>

            {keys.length === 0 ? (
              <div className="account-empty-state">
                <KeyRound aria-hidden="true" />
                <p>No API keys configured. Use the form above to generate machine tokens for automated workflows.</p>
              </div>
            ) : (
              <div className="account-table-wrapper">
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
                      <th>Last Used</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((key) => (
                      <tr key={key.id}>
                        <td className="key-name-cell">
                          <strong>{key.name}</strong>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="key-prefix-copy"
                            onClick={() => void copyPrefix(key.prefix)}
                            title="Click to copy prefix"
                          >
                            <code>{key.prefix}</code>
                            {copiedKey === key.prefix ? <Check aria-hidden="true" style={{ width: 12, height: 12 }} /> : <Copy aria-hidden="true" style={{ width: 12, height: 12 }} />}
                          </button>
                        </td>
                        <td>
                          <div className="account-key-grants">
                            {key.permissions.map((permission) => (
                              <code key={permission} className="permission-tag">{permission}</code>
                            ))}
                          </div>
                        </td>
                        <td>
                          <span className="engine-access-badge">
                            {key.engine_access.all ? 'All Engines' : `${key.engine_access.engines.length} selected`}
                          </span>
                        </td>
                        <td>
                          {key.boundary && Object.keys(key.boundary).length ? (
                            <div className="account-key-grants">
                              {Object.entries(key.boundary).flatMap(([kind, values]) =>
                                (values ?? []).map((value) => (
                                  <code key={`${kind}-${value}`} className="boundary-tag">{kind}:{value}</code>
                                ))
                              )}
                            </div>
                          ) : (
                            <span className="account-dimmed">Unrestricted</span>
                          )}
                        </td>
                        <td>{new Date(key.created_at).toLocaleDateString('en-GB')}</td>
                        <td>{key.expires_at ? new Date(key.expires_at).toLocaleString('en-GB') : 'Never'}</td>
                        <td>
                          {key.last_used_at ? (
                            new Date(key.last_used_at).toLocaleDateString('en-GB')
                          ) : (
                            <span className="account-dimmed">Never</span>
                          )}
                        </td>
                        <td>
                          <div className="account-actions">
                            <Button size="sm" variant="ghost" onClick={() => void rotateKey(key.id)} title="Rotate key (invalidates previous secret)">
                              <RotateCcw aria-hidden="true" style={{ width: 12, height: 12 }} /> Rotate
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void revokeKey(key.id)} title="Revoke this key">
                              <Trash2 aria-hidden="true" style={{ width: 12, height: 12 }} /> Revoke
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </section>

        {/* ========================================================================= */}
        {/* TAB 4: Execution History */}
        {/* ========================================================================= */}
        <section
          id="tab-pane-history"
          role="tabpanel"
          aria-labelledby="tab-btn-history"
          className={`account-tab-pane ${activeTab === 'history' ? 'is-active' : 'is-inactive'}`}
        >
          <Card padding="lg" className="account-history-card">
            <div className="account-section-heading">
              <div>
                <h2>Execution History &amp; Solves</h2>
                <p className="account-card-subtitle">
                  {history
                    ? `Displaying the last ${history.total} solve${history.total === 1 ? '' : 's'}, retained for ${history.retention_days} days under your active plan.`
                    : 'Verifiable record of binding problems evaluated across all accessible Engines.'}
                </p>
              </div>
              <Badge variant="info">{history?.retention_days ?? 7} Days Retention</Badge>
            </div>

            {!history || history.jobs.length === 0 ? (
              <div className="account-empty-state">
                <Cpu aria-hidden="true" />
                <p>
                  No solve executions recorded yet. Launch an optimization run in the{' '}
                  <Link to="/app/workbench" viewTransition>Workbench</Link> or Playground to see evaluated bindings here.
                </p>
              </div>
            ) : (
              <div className="account-table-wrapper">
                <table className="account-table">
                  <thead>
                    <tr>
                      <th>Engine</th>
                      <th>Status</th>
                      <th>Termination &amp; Solutions</th>
                      <th>Executed When</th>
                      <th>Inspect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.jobs.map((job) => (
                      <Fragment key={job.id}>
                        <tr>
                          <td>
                            <code className="engine-id-cell">{job.engine_id}</code>
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
                              <span className="job-termination-desc">
                                <strong>{job.termination}</strong>
                                {job.solutions != null && ` · ${job.solutions} solution${job.solutions === 1 ? '' : 's'}`}
                              </span>
                            ) : (
                              <span className="account-dimmed">—</span>
                            )}
                          </td>
                          <td>{new Date(job.created_at).toLocaleString('en-GB')}</td>
                          <td>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={job.status !== 'completed' || loadingSolution === job.id}
                              title={
                                job.status === 'completed'
                                  ? 'Show the binding produced by this solver'
                                  : 'Solve has not completed successfully'
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
              </div>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

/**
 * A finished solve, as the reference evaluator scored it.
 */
function SolutionPanel({ job, onDownload }: { job: JobStatus; onDownload: () => void }) {
  const solution = job.result?.solutions?.[0];
  const binding = solution?.decision.binding ?? null;
  const objective = solution?.objectives.score;
  const metrics = solution?.metrics;

  if (!solution) {
    return (
      <div className="account-solution-empty">
        <p>
          This solve finished without producing a binding
          {job.result?.termination === 'INFEASIBLE'
            ? ': no assignment satisfies every declared constraint.'
            : '.'}
        </p>
      </div>
    );
  }

  return (
    <div className="account-solution-panel">
      <BindingAnalysis result={job.result} jobId={job.id} />
      <header className="account-solution-head">
        <div className="account-solution-meta">
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
              {job.result.termination}
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
        </div>
        <Button size="sm" variant="secondary" onClick={onDownload}>
          <FileDown aria-hidden="true" style={{ width: 13, height: 13 }} /> Download JSON
        </Button>
      </header>

      {metrics && Object.keys(metrics).length > 0 && (
        <div className="account-solution-metrics-row">
          {Object.entries(metrics).map(([name, value]) => (
            <div key={name} className="metric-pill">
              <span className="metric-key">{name}</span>
              <strong className="metric-value">
                {typeof value === 'number' ? value.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : String(value)}
              </strong>
            </div>
          ))}
        </div>
      )}

      {binding && Object.keys(binding).length > 0 ? (
        <div className="account-binding-table-wrap">
          <table className="account-binding">
            <thead>
              <tr>
                <th>Task</th>
                <th>Candidate Binding</th>
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
        </div>
      ) : (
        <p className="account-empty">The solution carries no binding assignment.</p>
      )}

      {(job.result?.solutions?.length ?? 0) > 1 && (
        <p className="account-solution-subtext">
          Showing the first of {job.result!.solutions!.length} evaluated solutions; all variants are available in the linked analysis above and downloaded document.
        </p>
      )}
    </div>
  );
}
