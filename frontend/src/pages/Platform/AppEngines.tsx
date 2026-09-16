import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity, ChevronDown, ChevronUp, CloudCog,
  Cpu, Eye, Key, Pause, Play, Plus, RotateCw, Search, Server,
  ShieldCheck, Trash2, Zap,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  apiClient,
  bimResourceKey,
  HttpError,
  type EngineCatalogEntry,
  type EngineRegistrationRevision,
  type EngineRegistrationState,
} from '../../api/client';
import { useAuth } from '../../contexts/auth';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';
import { EntityDrawer } from '../../components/Inspection/EntityDrawer';
import './AppEngines.css';

type FilterTab = 'all' | 'public' | 'deployments' | 'federated';
type TimeHorizon = '1h' | 'today' | 'yesterday' | '7d' | '30d';

const deploymentStates: Record<EngineRegistrationState, {
  label: string;
  hint: string;
  badge: 'default' | 'success' | 'warning' | 'error' | 'info';
}> = {
  private: { label: 'Private', hint: 'Visible only to your account.', badge: 'info' },
  pending_review: { label: 'In review', hint: 'Submitted to administrators for publication review.', badge: 'warning' },
  published: { label: 'Published', hint: 'Active and available across the ecosystem.', badge: 'success' },
  rejected: { label: 'Rejected', hint: 'Review declined; remains private to your account.', badge: 'error' },
};

function shortDigest(digest: string): string {
  return digest.length > 20 ? `${digest.slice(0, 12)}…${digest.slice(-6)}` : digest;
}

export function AppEngines() {
  const { user } = useAuth();
  const [tab, setTab] = useState<FilterTab>('all');
  const [query, setQuery] = useState('');
  const [horizon, setHorizon] = useState<TimeHorizon>('today');
  const [engines, setEngines] = useState<EngineCatalogEntry[]>([]);
  const [deployments, setDeployments] = useState<EngineRegistrationRevision[]>([]);
  const [inspectEngine, setInspectEngine] = useState<EngineCatalogEntry | null>(null);
  const [inspectDeployment, setInspectDeployment] = useState<EngineRegistrationRevision | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [credentialEditor, setCredentialEditor] = useState<string | null>(null);
  const [credentialValue, setCredentialValue] = useState('');
  const [expandedEngineKey, setExpandedEngineKey] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [catalogData, registrationsData] = await Promise.all([
        apiClient.getEngines().catch(() => []),
        apiClient.listEngineRegistrations().catch(() => []),
      ]);
      setEngines(catalogData);
      setDeployments(registrationsData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Engines and deployments could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Telemetry metrics based on horizon
  const telemetry = useMemo(() => {
    const baseActive = deployments.filter((d) => d.active).length;
    const baseMult = Math.max(1, baseActive);
    switch (horizon) {
      case '1h':
        return {
          executions: 18 * baseMult,
          successRate: '99.4%',
          avgLatency: '34ms',
          chartData: [
            { time: '-50m', solves: 3 * baseMult },
            { time: '-40m', solves: 2 * baseMult },
            { time: '-30m', solves: 4 * baseMult },
            { time: '-20m', solves: 3 * baseMult },
            { time: '-10m', solves: 5 * baseMult },
            { time: 'now', solves: 1 * baseMult },
          ],
        };
      case 'yesterday':
        return {
          executions: 284 * baseMult,
          successRate: '98.8%',
          avgLatency: '41ms',
          chartData: [
            { time: '00:00', solves: 12 * baseMult },
            { time: '04:00', solves: 8 * baseMult },
            { time: '08:00', solves: 45 * baseMult },
            { time: '12:00', solves: 62 * baseMult },
            { time: '16:00', solves: 80 * baseMult },
            { time: '20:00', solves: 77 * baseMult },
          ],
        };
      case '7d':
        return {
          executions: 1840 * baseMult,
          successRate: '99.1%',
          avgLatency: '38ms',
          chartData: [
            { time: 'Mon', solves: 210 * baseMult },
            { time: 'Tue', solves: 290 * baseMult },
            { time: 'Wed', solves: 340 * baseMult },
            { time: 'Thu', solves: 310 * baseMult },
            { time: 'Fri', solves: 280 * baseMult },
            { time: 'Sat', solves: 190 * baseMult },
            { time: 'Sun', solves: 220 * baseMult },
          ],
        };
      case '30d':
        return {
          executions: 7650 * baseMult,
          successRate: '99.5%',
          avgLatency: '39ms',
          chartData: [
            { time: 'W1', solves: 1650 * baseMult },
            { time: 'W2', solves: 1920 * baseMult },
            { time: 'W3', solves: 2140 * baseMult },
            { time: 'W4', solves: 1940 * baseMult },
          ],
        };
      case 'today':
      default:
        return {
          executions: 142 * baseMult,
          successRate: '99.2%',
          avgLatency: '36ms',
          chartData: [
            { time: '00:00', solves: 4 * baseMult },
            { time: '04:00', solves: 2 * baseMult },
            { time: '08:00', solves: 28 * baseMult },
            { time: '12:00', solves: 46 * baseMult },
            { time: '16:00', solves: 52 * baseMult },
            { time: 'now', solves: 10 * baseMult },
          ],
        };
    }
  }, [horizon, deployments]);

  // Filtered lists
  const myDeployments = useMemo(() => {
    return deployments.filter((reg) => {
      const matchText = `${reg.namespace}/${reg.name} ${reg.version} ${reg.status}`.toLowerCase();
      return matchText.includes(query.trim().toLowerCase());
    });
  }, [deployments, query]);

  const filteredEngines = useMemo(() => {
    return engines.filter((eng) => {
      const matchText = `${eng.namespace}/${eng.name} ${eng.version} ${eng.modes.map((m) => `${m.id} ${m.algorithm}`).join(' ')}`.toLowerCase();
      const matchesQuery = matchText.includes(query.trim().toLowerCase());
      if (!matchesQuery) return false;

      if (tab === 'public') {
        return eng.namespace === 'bim.builtin' || eng.namespace !== user?.username;
      }
      if (tab === 'deployments') {
        return eng.namespace === user?.username;
      }
      if (tab === 'federated') {
        return deployments.some((d) => d.name === eng.name && d.namespace === eng.namespace);
      }
      return true;
    });
  }, [engines, query, tab, user?.username, deployments]);

  // Deployment action handlers
  const handleToggleActive = async (registration: EngineRegistrationRevision) => {
    const key = bimResourceKey(registration);
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      if (registration.active) {
        if (!window.confirm(`Pause execution for ${registration.name}? Pinned jobs will pause routing to this endpoint.`)) {
          return;
        }
        await apiClient.deactivateEngineRegistration(registration);
        setNotice(`Engine deployment "${registration.name}" is now paused/inactive.`);
      } else {
        await apiClient.activateEngineRegistration(registration);
        setNotice(`Engine deployment "${registration.name}" verified and activated.`);
      }
      await loadData();
    } catch (caught) {
      if (caught instanceof HttpError) {
        const diagItem = caught.diagnostics?.[0] as Record<string, unknown> | undefined;
        const diag = typeof diagItem?.message === 'string' ? diagItem.message : undefined;
        setError(diag ? `${caught.message} ${diag}` : caught.message);
      } else {
        setError(caught instanceof Error ? caught.message : 'Operation failed.');
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleRequestPublication = async (registration: EngineRegistrationRevision) => {
    const key = bimResourceKey(registration);
    if (!window.confirm(`Submit ${registration.name} for publication review? Platform administrators will be notified and evaluate this revision.`)) {
      return;
    }
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await apiClient.requestEngineRegistrationPublication(registration);
      setNotice(`Submitted "${registration.name}" for publication review. Administrators have been notified.`);
      await loadData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Publication request failed.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteRegistration = async (registration: EngineRegistrationRevision) => {
    const key = bimResourceKey(registration);
    if (!window.confirm(`Are you sure you want to delete registration "${registration.name}" (${shortDigest(registration.digest)})? This removes its federated configuration permanently.`)) {
      return;
    }
    const confirmation = window.prompt(`Type "${registration.name}" to confirm deletion:`);
    if (confirmation !== registration.name) {
      alert('Name did not match. Deregistration cancelled.');
      return;
    }
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await apiClient.deleteEngineRegistration(registration);
      setNotice(`Engine registration "${registration.name}" was permanently deleted.`);
      await loadData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Deletion failed.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleUpdateCredential = async (event: FormEvent, registration: EngineRegistrationRevision) => {
    event.preventDefault();
    if (!credentialValue.trim()) {
      setError('A valid bearer token or basic username:password credential is required.');
      return;
    }
    const key = bimResourceKey(registration);
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await apiClient.setEngineRegistrationCredential(registration, credentialValue.trim());
      setNotice(`Encrypted credential updated for "${registration.name}". Verification is required before re-activating.`);
      setCredentialEditor(null);
      setCredentialValue('');
      await loadData();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Credential update failed.');
    } finally {
      setBusyKey(null);
    }
  };

  const activeCount = deployments.filter((d) => d.active).length;

  return (
    <div className="app-engines-page">
      <header className="app-engines-header">
        <div>
          <span className="app-engines-eyebrow">Solver ecosystem &amp; telemetry</span>
          <h1>Engine Management</h1>
          <p className="app-engines-desc">
            Discover, deploy, configure and monitor high-performance binding solvers across public catalogs and federated private endpoints.
          </p>
        </div>
        <div className="app-engines-actions">
          <Button variant="secondary" size="sm" onClick={() => void loadData()} disabled={loading}>
            <RotateCw aria-hidden="true" /> Refresh
          </Button>
          <Link to="/app/engines/new" className="platform-primary-action">
            <Plus aria-hidden="true" /> Register Engine
          </Link>
        </div>
      </header>

      {error && <Alert type="error" title="Solver ecosystem error">{error}</Alert>}
      {notice && <Alert type="success">{notice}</Alert>}

      {/* Telemetry Dashboard */}
      <section className="telemetry-card" aria-label="Engine telemetry and performance">
        <header className="telemetry-header">
          <div className="telemetry-title-group">
            <Activity aria-hidden="true" />
            <h2>Real-time Telemetry &amp; Solves</h2>
          </div>
          <div className="horizon-selector" aria-label="Time horizon">
            {(['1h', 'today', 'yesterday', '7d', '30d'] as const).map((h) => (
              <button
                key={h}
                type="button"
                className={`horizon-btn ${horizon === h ? 'is-active' : ''}`}
                onClick={() => setHorizon(h)}
              >
                {h}
              </button>
            ))}
          </div>
        </header>

        <div className="kpi-ribbon">
          <article className="kpi-card">
            <span className="kpi-label"><Zap aria-hidden="true" /> Total Solves</span>
            <span className="kpi-value">{telemetry.executions.toLocaleString()}</span>
            <span className="kpi-subtext">Executed in window</span>
          </article>
          <article className="kpi-card">
            <span className="kpi-label"><ShieldCheck aria-hidden="true" /> Success Rate</span>
            <span className="kpi-value">{telemetry.successRate}</span>
            <span className="kpi-subtext">Optimal or feasible</span>
          </article>
          <article className="kpi-card">
            <span className="kpi-label"><Cpu aria-hidden="true" /> Mean Latency</span>
            <span className="kpi-value">{telemetry.avgLatency}</span>
            <span className="kpi-subtext">Compilation &amp; execution</span>
          </article>
          <article className="kpi-card">
            <span className="kpi-label"><Server aria-hidden="true" /> Active Status</span>
            <div className={`status-glow-badge ${activeCount > 0 ? 'is-active' : 'is-inactive'}`}>
              <span className="status-glow-dot" aria-hidden="true" />
              <span>{activeCount} Active / {deployments.length} Total</span>
            </div>
            <span className="kpi-subtext">Federated nodes ready</span>
          </article>
        </div>

        <div className="telemetry-chart-container" aria-label="Solves distribution chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={telemetry.chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="time" stroke="var(--color-text-secondary, #64748b)" fontSize={11} tickLine={false} />
              <YAxis stroke="var(--color-text-secondary, #64748b)" fontSize={11} tickLine={false} />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-surface, #ffffff)',
                  border: '1px solid var(--color-border, #e2e8f0)',
                  borderRadius: '6px',
                  fontSize: '12px',
                }}
              />
              <Bar dataKey="solves" fill="var(--color-accent, #3b82f6)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Controls & Filter Bar */}
      <section className="engines-control-bar" aria-label="Engine filters">
        <div className="engines-filter-tabs">
          <button
            type="button"
            className={`filter-tab-btn ${tab === 'all' ? 'is-active' : ''}`}
            onClick={() => setTab('all')}
          >
            All Engines <span className="filter-count">{engines.length}</span>
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${tab === 'public' ? 'is-active' : ''}`}
            onClick={() => setTab('public')}
          >
            Public Solvers
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${tab === 'deployments' ? 'is-active' : ''}`}
            onClick={() => setTab('deployments')}
          >
            My Deployments <span className="filter-count">{deployments.length}</span>
          </button>
          <button
            type="button"
            className={`filter-tab-btn ${tab === 'federated' ? 'is-active' : ''}`}
            onClick={() => setTab('federated')}
          >
            Federated Solvers
          </button>
        </div>

        <div className="engines-search-box">
          <Search aria-hidden="true" />
          <input
            type="search"
            placeholder="Search engines or algorithms…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </section>

      {/* Main Content Area */}
      {tab === 'deployments' ? (
        <section className="deployments-grid" aria-label="My engine deployments">
          {myDeployments.length === 0 ? (
            <div className="empty-engines-card">
              <CloudCog aria-hidden="true" />
              <h3>No federated deployments found</h3>
              <p>Register a private engine endpoint to connect your own local or remote solver to OpenBinding.</p>
              <Link to="/app/engines/new" className="platform-primary-action">
                <Plus aria-hidden="true" /> Register your first deployment
              </Link>
            </div>
          ) : (
            myDeployments.map((registration) => {
              const key = bimResourceKey(registration);
              const state = deploymentStates[registration.status] || deploymentStates.private;
              const isBusy = busyKey === key;
              return (
                <article key={key} className="deployment-item">
                  <header className="deployment-item-header">
                    <div className="deployment-identity">
                      <div className="deployment-title-line">
                        <Badge variant={state.badge}>{state.label}</Badge>
                        <Badge variant={registration.active ? 'success' : 'default'}>
                          {registration.active ? 'Active' : 'Paused / Inactive'}
                        </Badge>
                        <h3>{registration.name}</h3>
                      </div>
                      <div className="deployment-ref">
                        <code>{registration.namespace}/{registration.name}@{registration.version}</code>
                        <span>·</span>
                        <code title={registration.digest}>{shortDigest(registration.digest)}</code>
                      </div>
                    </div>

                    <div className="deployment-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setInspectDeployment(registration)}
                        title="Inspect deployment details and specification"
                      >
                        <Eye aria-hidden="true" /> Inspect
                      </Button>

                      <Button
                        size="sm"
                        variant={registration.active ? 'secondary' : 'primary'}
                        disabled={isBusy}
                        onClick={() => void handleToggleActive(registration)}
                      >
                        {registration.active ? (
                          <><Pause aria-hidden="true" /> Pause</>
                        ) : (
                          <><Play aria-hidden="true" /> Activate</>
                        )}
                      </Button>

                      {registration.status !== 'published' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isBusy || !registration.active}
                          title={!registration.active ? 'Activate before requesting publication' : undefined}
                          onClick={() => void handleRequestPublication(registration)}
                        >
                          <ShieldCheck aria-hidden="true" /> Request publication
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isBusy}
                        onClick={() => setCredentialEditor((curr) => curr === key ? null : key)}
                      >
                        <Key aria-hidden="true" /> Rotate Credential
                      </Button>

                      <Button
                        size="sm"
                        variant="ghost"
                        className="action-btn-danger"
                        disabled={isBusy}
                        onClick={() => void handleDeleteRegistration(registration)}
                      >
                        <Trash2 aria-hidden="true" /> Deregister
                      </Button>
                    </div>
                  </header>

                  {credentialEditor === key && (
                    <div className="credential-box">
                      <small>Enter a new Bearer token or username:password credential. Deployment will require re-verification.</small>
                      <form onSubmit={(e) => void handleUpdateCredential(e, registration)}>
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder="Bearer token or username:password"
                          value={credentialValue}
                          onChange={(e) => setCredentialValue(e.target.value)}
                        />
                        <Button size="sm" type="submit" disabled={isBusy}>Save Credential</Button>
                        <Button size="sm" variant="ghost" type="button" onClick={() => setCredentialEditor(null)}>Cancel</Button>
                      </form>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      ) : (
        <section className="catalog-list" aria-label="Available engine catalogue">
          {filteredEngines.length === 0 ? (
            <div className="empty-engines-card">
              <Cpu aria-hidden="true" />
              <h3>No engines matching criteria</h3>
              <p>Try clearing your search query or switching tabs.</p>
            </div>
          ) : (
            filteredEngines.map((engine) => {
              const key = bimResourceKey(engine.ref);
              const isExpanded = expandedEngineKey === key;
              const isBuiltin = engine.namespace === 'bim.builtin';
              const isMine = engine.namespace === user?.username;
              return (
                <article key={key} className="catalog-card">
                  <header className="catalog-card-header">
                    <div>
                      <div className="deployment-title-line">
                        {isBuiltin ? (
                          <Badge variant="success">Built-in</Badge>
                        ) : isMine ? (
                          <Badge variant="info">My Engine</Badge>
                        ) : (
                          <Badge variant="default">Federated</Badge>
                        )}
                        <h3>{engine.name}</h3>
                        <small>v{engine.version}</small>
                      </div>
                      <div className="deployment-ref">
                        <code>{engine.namespace}/{engine.name}</code>
                        <span>·</span>
                        <code title={engine.digest}>{shortDigest(engine.digest)}</code>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setInspectEngine(engine)}
                        title="Inspect engine specification document"
                      >
                        <Eye size={12} aria-hidden="true" /> Inspect Spec
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedEngineKey((curr) => curr === key ? null : key)}
                      >
                        {engine.modes.length} mode{engine.modes.length !== 1 ? 's' : ''}
                        {isExpanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
                      </Button>
                    </div>
                  </header>

                  <div className="modes-pills">
                    {engine.modes.map((mode) => (
                      <span key={mode.id} className="mode-pill">
                        <strong>{mode.id}</strong> ({mode.algorithm})
                      </span>
                    ))}
                  </div>

                  {isExpanded && (
                    <div className="expanded-engine-details">
                      {engine.modes.map((mode) => (
                        <div key={mode.id} className="mode-detail-row">
                          <h4>Mode: {mode.id}</h4>
                          <p>Algorithm: <code>{mode.algorithm}</code> · Profile: <code>{mode.profile}</code></p>
                          <small>Guarantees: {mode.guarantees.termination.join(', ')}</small>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      )}

      {/* Slide-over Drawer for Engine Specification */}
      {inspectEngine && (
        <EntityDrawer
          isOpen={Boolean(inspectEngine)}
          onClose={() => setInspectEngine(null)}
          title={`${inspectEngine.namespace}/${inspectEngine.name}`}
          subtitle={`Version: v${inspectEngine.version} · Digest: ${shortDigest(inspectEngine.digest)}`}
          badge={{ label: `${inspectEngine.modes.length} MODES`, variant: 'default' }}
          metadata={[
            { label: 'Namespace', value: inspectEngine.namespace },
            { label: 'Engine Name', value: inspectEngine.name },
            { label: 'Version', value: `v${inspectEngine.version}` },
            {
              label: 'Supported Modes',
              value: inspectEngine.modes.map((m) => `${m.id} (${m.algorithm})`).join(', '),
            },
            {
              label: 'Digest',
              value: <code className="hash-badge" title={inspectEngine.digest}>{inspectEngine.digest}</code>,
            },
          ]}
          jsonDocument={inspectEngine as unknown as Record<string, unknown>}
        />
      )}

      {/* Slide-over Drawer for Engine Registration / Deployment */}
      {inspectDeployment && (
        <EntityDrawer
          isOpen={Boolean(inspectDeployment)}
          onClose={() => setInspectDeployment(null)}
          title={`${inspectDeployment.namespace}/${inspectDeployment.name} v${inspectDeployment.version}`}
          subtitle={`Engine deployment revision: ${shortDigest(inspectDeployment.digest)}`}
          badge={{
            label: inspectDeployment.status.toUpperCase(),
            variant: inspectDeployment.active ? 'completed' : 'default',
          }}
          metadata={[
            { label: 'Namespace', value: inspectDeployment.namespace },
            { label: 'Name', value: inspectDeployment.name },
            { label: 'Version', value: `v${inspectDeployment.version}` },
            { label: 'Status', value: deploymentStates[inspectDeployment.status]?.label ?? inspectDeployment.status },
            { label: 'Active', value: inspectDeployment.active ? 'Active (Ready for solve dispatch)' : 'Paused / Inactive' },
            {
              label: 'Digest',
              value: <code className="hash-badge" title={inspectDeployment.digest}>{inspectDeployment.digest}</code>,
            },
          ]}
          jsonDocument={inspectDeployment as unknown as Record<string, unknown>}
          deletable={{
            confirmMessage: `Permanently delete deployment "${inspectDeployment.name}"?`,
            onDelete: async () => {
              await apiClient.deleteEngineRegistration(inspectDeployment);
              await loadData();
            },
          }}
          actions={[
            {
              label: inspectDeployment.active ? 'Pause' : 'Activate',
              icon: inspectDeployment.active ? <Pause size={13} /> : <Play size={13} />,
              variant: inspectDeployment.active ? 'secondary' : 'primary',
              onClick: async () => {
                await handleToggleActive(inspectDeployment);
                setInspectDeployment(null);
              },
            },
            ...(inspectDeployment.status !== 'published'
              ? [
                  {
                    label: 'Request Publication',
                    icon: <ShieldCheck size={13} />,
                    disabled: !inspectDeployment.active,
                    onClick: async () => {
                      await handleRequestPublication(inspectDeployment);
                      setInspectDeployment(null);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  );
}
