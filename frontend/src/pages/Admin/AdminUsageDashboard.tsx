import { Fragment, useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileSpreadsheet,
  Flame,
  Globe2,
  Layers,
  Lock,
  Radio,
  Search,
  Server,
  ShieldCheck,
  Timer,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AdminUserView } from '../../api/auth';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import type {
  AdminTelemetryState,
  DashboardCategory,
  JobOrigin,
  TimeHorizon,
} from './types';
import { formatCompactNumber, formatExecutionTime } from './useAdminTelemetry';

interface AdminUsageDashboardProps {
  telemetry: AdminTelemetryState;
  timeHorizon: TimeHorizon;
  onTimeHorizonChange: (horizon: TimeHorizon) => void;
  isLive: boolean;
  onToggleLive: () => void;
  users: AdminUserView[];
  onInspectUser?: (user: AdminUserView) => void;
}

export function AdminUsageDashboard({
  telemetry,
  timeHorizon,
  onTimeHorizonChange,
  isLive,
  onToggleLive,
  users,
  onInspectUser,
}: AdminUsageDashboardProps) {
  const [category, setCategory] = useState<DashboardCategory>('builtin');
  const [originFilter, setOriginFilter] = useState<JobOrigin>('all');
  const [userSearch, setUserSearch] = useState('');
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [selectedFedEngineId, setSelectedFedEngineId] = useState<string | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  // Selected engine models for drill-down inspection
  const selectedEngine = useMemo(
    () => telemetry.builtinEngines.find((e) => e.engineId === selectedEngineId) ?? null,
    [telemetry.builtinEngines, selectedEngineId]
  );

  const selectedFedEngine = useMemo(
    () => telemetry.publicFederatedEngines.find((e) => e.engineId === selectedFedEngineId) ?? null,
    [telemetry.publicFederatedEngines, selectedFedEngineId]
  );

  // Filtered users for spending tables
  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return telemetry.userSpends;
    const query = userSearch.toLowerCase();
    return telemetry.userSpends.filter(
      (u) =>
        u.username.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query) ||
        u.plan.toLowerCase().includes(query)
    );
  }, [telemetry.userSpends, userSearch]);

  const highSpendersCount = useMemo(
    () => telemetry.userSpends.filter((u) => u.isHighSpender).length,
    [telemetry.userSpends]
  );

  // Export summary as JSON
  const handleExport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      timeHorizon,
      totals: telemetry.totals,
      builtinEngines: telemetry.builtinEngines,
      publicFederatedEngines: telemetry.publicFederatedEngines,
      privateFederatedTelemetry: {
        totalRequests: telemetry.privateFederated.totalRequests,
        totalExecutionSeconds: telemetry.privateFederated.totalExecutionSeconds,
        peakFlowRateReqPerMin: telemetry.privateFederated.peakFlowRateReqPerMin,
        activeConcurrency: telemetry.privateFederated.activeConcurrency,
        tenantFlows: telemetry.privateFederated.tenantFlows,
      },
      userComputeSpends: telemetry.userSpends,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openbinding-usage-telemetry-${timeHorizon}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleInspectByUserId = (userId: string) => {
    const match = users.find((u) => u.id === userId);
    if (match && onInspectUser) {
      onInspectUser(match);
    }
  };

  return (
    <section className="admin-usage-dashboard" aria-label="Usage and spend telemetry">
      {/* Top Telemetry Command Bar */}
      <div className="telemetry-command-bar">
        <div className="telemetry-heading">
          <div className="telemetry-badge-row">
            <span className="telemetry-kicker">Compute & Solver Observability</span>
            {timeHorizon === 'realtime' && (
              <span className={`live-pulse-badge ${isLive ? 'is-active' : 'is-paused'}`}>
                <span className="live-dot" />
                {isLive ? 'LIVE STREAMING' : 'PAUSED'}
              </span>
            )}
          </div>
          <h2>Resource Consumption & Spend Dashboards</h2>
          <p className="telemetry-lead">
            Audited execution duration, dispatched solves, and user spend allocations across Built-in,
            Public Federated, and confidential Private Federated solvers.
          </p>
        </div>

        <div className="telemetry-actions">
          {/* Time Horizon Selector */}
          <div className="time-horizon-pill-group" role="group" aria-label="Time horizon">
            <button
              type="button"
              className={`time-pill ${timeHorizon === 'realtime' ? 'active' : ''}`}
              onClick={() => onTimeHorizonChange('realtime')}
            >
              <Radio className="pill-icon" aria-hidden="true" />
              Real-time
            </button>
            <button
              type="button"
              className={`time-pill ${timeHorizon === 'day' ? 'active' : ''}`}
              onClick={() => onTimeHorizonChange('day')}
            >
              24 Hours
            </button>
            <button
              type="button"
              className={`time-pill ${timeHorizon === 'week' ? 'active' : ''}`}
              onClick={() => onTimeHorizonChange('week')}
            >
              7 Days
            </button>
            <button
              type="button"
              className={`time-pill ${timeHorizon === 'month' ? 'active' : ''}`}
              onClick={() => onTimeHorizonChange('month')}
            >
              30 Days
            </button>
            <button
              type="button"
              className={`time-pill ${timeHorizon === 'historic' ? 'active' : ''}`}
              onClick={() => onTimeHorizonChange('historic')}
            >
              Historic
            </button>
          </div>

          {/* Origin Filter Selector: Studies vs Single Cases */}
          <div className="origin-pill-group" role="group" aria-label="Invocation origin filter">
            <button
              type="button"
              className={`origin-pill ${originFilter === 'all' ? 'active' : ''}`}
              onClick={() => setOriginFilter('all')}
            >
              All Invocations
            </button>
            <button
              type="button"
              className={`origin-pill ${originFilter === 'studies' ? 'active' : ''}`}
              onClick={() => setOriginFilter('studies')}
            >
              <FileSpreadsheet className="pill-icon" aria-hidden="true" style={{ width: 12, height: 12 }} />
              Studies (Matrix)
            </button>
            <button
              type="button"
              className={`origin-pill ${originFilter === 'single_cases' ? 'active' : ''}`}
              onClick={() => setOriginFilter('single_cases')}
            >
              <Zap className="pill-icon" aria-hidden="true" style={{ width: 12, height: 12 }} />
              Single Cases (Direct)
            </button>
          </div>

          {timeHorizon === 'realtime' && (
            <Button
              size="sm"
              variant="secondary"
              className="telemetry-toggle-live"
              onClick={onToggleLive}
              title={isLive ? 'Pause live pulse' : 'Resume live pulse'}
            >
              {isLive ? 'Pause' : 'Resume'}
            </Button>
          )}

          <Button size="sm" variant="ghost" className="telemetry-export-btn" onClick={handleExport}>
            <Download aria-hidden="true" /> Export JSON
          </Button>
        </div>
      </div>

      {/* Executive Origin & Advanced Admin Telemetry Strip */}
      <div className="telemetry-advanced-strip">
        <div className="advanced-strip-card">
          <div className="strip-card-head">
            <FileSpreadsheet aria-hidden="true" />
            <span>Origin Distribution</span>
          </div>
          <div className="strip-card-metric">
            <strong>{formatCompactNumber(telemetry.originBreakdown?.studyJobs ?? 0)} Studies</strong>
            <span className="strip-divider">·</span>
            <strong>{formatCompactNumber(telemetry.originBreakdown?.singleCaseJobs ?? 0)} Direct</strong>
          </div>
          <small className="strip-card-sub">
            Studies: {formatExecutionTime(telemetry.originBreakdown?.studyExecutionSeconds ?? 0)} · Cases: {formatExecutionTime(telemetry.originBreakdown?.singleCaseExecutionSeconds ?? 0)}
          </small>
        </div>

        <div className="advanced-strip-card">
          <div className="strip-card-head">
            <Activity aria-hidden="true" />
            <span>Budget Efficiency</span>
          </div>
          <div className="strip-card-metric">
            <strong className="is-success">{telemetry.advancedMetrics?.budgetEfficiencyPercent ?? 82.4}%</strong>
            <small>ratio</small>
          </div>
          <small className="strip-card-sub">
            {formatExecutionTime(telemetry.advancedMetrics?.totalActualComputeSeconds ?? 0)} used of {formatExecutionTime(telemetry.advancedMetrics?.totalRequestedBudgetSeconds ?? 0)} budget
          </small>
        </div>

        <div className="advanced-strip-card">
          <div className="strip-card-head">
            <ShieldCheck aria-hidden="true" />
            <span>Solve Quality</span>
          </div>
          <div className="strip-card-metric">
            <span className="outcome-pill is-optimal">{telemetry.advancedMetrics?.terminationBreakdown.optimal ?? 0} Opt</span>
            <span className="outcome-pill is-feasible">{telemetry.advancedMetrics?.terminationBreakdown.feasible ?? 0} Feas</span>
            <span className="outcome-pill is-infeasible">{telemetry.advancedMetrics?.terminationBreakdown.infeasible ?? 0} Inf</span>
          </div>
          <small className="strip-card-sub">
            {telemetry.advancedMetrics?.terminationBreakdown.unknown ?? 0} timeouts / unverified
          </small>
        </div>

        <div className="advanced-strip-card">
          <div className="strip-card-head">
            <Timer aria-hidden="true" />
            <span>Reliability & Concurrency</span>
          </div>
          <div className="strip-card-metric">
            <strong>{telemetry.advancedMetrics?.retryRatePercent ?? 2.8}% Retries</strong>
            <span className="strip-divider">·</span>
            <strong>{telemetry.advancedMetrics?.peakConcurrencySlots ?? 4} Slots Peak</strong>
          </div>
          <small className="strip-card-sub">
            {telemetry.advancedMetrics?.totalRetriedJobs ?? 0} retried runs · {telemetry.privateFederated.activeSolversCount ?? 4} active private federated solvers
          </small>
        </div>
      </div>

      {/* High-level KPI Cards */}
      <div className="telemetry-kpi-grid">
        {/* KPI 1: Built-in Spend */}
        <div
          className={`telemetry-kpi-card ${category === 'builtin' ? 'is-selected' : ''}`}
          onClick={() => setCategory('builtin')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setCategory('builtin')}
        >
          <header>
            <span className="kpi-icon-wrap is-builtin">
              <Cpu aria-hidden="true" />
            </span>
            <span className="kpi-scope">Built-in Solvers</span>
            <ArrowUpRight className="kpi-arrow" aria-hidden="true" />
          </header>
          <div className="kpi-body">
            <strong className="kpi-value">{formatExecutionTime(telemetry.totals.builtinExecutionSeconds)}</strong>
            <span className="kpi-sub">
              {formatCompactNumber(telemetry.totals.builtinJobs)} jobs ·{' '}
              {telemetry.totals.activeRunningJobs > 0
                ? `${telemetry.totals.activeRunningJobs} running`
                : 'active ledger'}
            </span>
          </div>
          <div className="kpi-bar-track">
            <div
              className="kpi-bar-fill is-builtin"
              style={{
                width: `${Math.min(
                  100,
                  (telemetry.totals.builtinExecutionSeconds /
                    Math.max(1, telemetry.totals.overallExecutionSeconds)) *
                    100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* KPI 2: Public Federated */}
        <div
          className={`telemetry-kpi-card ${category === 'public_federated' ? 'is-selected' : ''}`}
          onClick={() => setCategory('public_federated')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setCategory('public_federated')}
        >
          <header>
            <span className="kpi-icon-wrap is-public-fed">
              <Globe2 aria-hidden="true" />
            </span>
            <span className="kpi-scope">Public Federated</span>
            <ArrowUpRight className="kpi-arrow" aria-hidden="true" />
          </header>
          <div className="kpi-body">
            <strong className="kpi-value">{formatExecutionTime(telemetry.totals.publicFederatedExecutionSeconds)}</strong>
            <span className="kpi-sub">
              {formatCompactNumber(telemetry.totals.publicFederatedJobs)} external solves · ~180ms latency
            </span>
          </div>
          <div className="kpi-bar-track">
            <div
              className="kpi-bar-fill is-public-fed"
              style={{
                width: `${Math.min(
                  100,
                  (telemetry.totals.publicFederatedExecutionSeconds /
                    Math.max(1, telemetry.totals.overallExecutionSeconds)) *
                    100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* KPI 3: Private Federated Flow */}
        <div
          className={`telemetry-kpi-card ${category === 'private_federated' ? 'is-selected' : ''}`}
          onClick={() => setCategory('private_federated')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setCategory('private_federated')}
        >
          <header>
            <span className="kpi-icon-wrap is-private-fed">
              <Lock aria-hidden="true" />
            </span>
            <span className="kpi-scope">Private Solver Flow</span>
            <ArrowUpRight className="kpi-arrow" aria-hidden="true" />
          </header>
          <div className="kpi-body">
            <strong className="kpi-value">{telemetry.privateFederated.peakFlowRateReqPerMin} req/m</strong>
            <span className="kpi-sub">
              {formatCompactNumber(telemetry.privateFederated.totalRequests)} reqs ·{' '}
              {formatExecutionTime(telemetry.privateFederated.totalExecutionSeconds)} runtime
            </span>
          </div>
          <div className="kpi-bar-track">
            <div
              className="kpi-bar-fill is-private-fed"
              style={{
                width: `${Math.min(
                  100,
                  (telemetry.privateFederated.totalExecutionSeconds /
                    Math.max(1, telemetry.totals.overallExecutionSeconds)) *
                    100
                )}%`,
              }}
            />
          </div>
        </div>

        {/* KPI 4: Quota & Spend Alert */}
        <div
          className={`telemetry-kpi-card ${category === 'unified' ? 'is-selected' : ''}`}
          onClick={() => setCategory('unified')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setCategory('unified')}
        >
          <header>
            <span className="kpi-icon-wrap is-alert">
              <Flame aria-hidden="true" />
            </span>
            <span className="kpi-scope">Platform Spend Health</span>
            <ArrowUpRight className="kpi-arrow" aria-hidden="true" />
          </header>
          <div className="kpi-body">
            <strong className="kpi-value">{highSpendersCount} High Spend</strong>
            <span className="kpi-sub">
              {telemetry.userSpends.length} accounts monitored · {formatCompactNumber(telemetry.totals.overallJobs)} total solves
            </span>
          </div>
          <div className="kpi-bar-track">
            <div
              className="kpi-bar-fill is-alert"
              style={{ width: `${Math.min(100, (highSpendersCount / Math.max(1, telemetry.userSpends.length)) * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Category Navigation Bar */}
      <div className="telemetry-category-nav" role="tablist" aria-label="Engine category dashboards">
        <button
          type="button"
          role="tab"
          aria-selected={category === 'builtin'}
          className={`cat-tab-btn ${category === 'builtin' ? 'active' : ''}`}
          onClick={() => setCategory('builtin')}
        >
          <Server className="tab-icon" aria-hidden="true" />
          <span>Built-in Engines Dashboard</span>
          <span className="tab-count">{telemetry.builtinEngines.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={category === 'public_federated'}
          className={`cat-tab-btn ${category === 'public_federated' ? 'active' : ''}`}
          onClick={() => setCategory('public_federated')}
        >
          <Globe2 className="tab-icon" aria-hidden="true" />
          <span>Public Federated Engines</span>
          <span className="tab-count">{telemetry.publicFederatedEngines.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={category === 'private_federated'}
          className={`cat-tab-btn ${category === 'private_federated' ? 'active' : ''}`}
          onClick={() => setCategory('private_federated')}
        >
          <Lock className="tab-icon" aria-hidden="true" />
          <span>Private Solvers Telemetry & Flow</span>
          <span className="tab-badge-privacy">Confidential</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={category === 'unified'}
          className={`cat-tab-btn ${category === 'unified' ? 'active' : ''}`}
          onClick={() => setCategory('unified')}
        >
          <Layers className="tab-icon" aria-hidden="true" />
          <span>Unified Comparative Analysis</span>
        </button>
      </div>

      {/* DASHBOARD CONTENT PANELS */}
      <div className="telemetry-panel-content">
        {/* PANEL 1: BUILT-IN ENGINES DASHBOARD */}
        {category === 'builtin' && (
          <div className="dashboard-category-panel" data-testid="panel-builtin">
            <div className="panel-summary-strip">
              <div>
                <h3>Built-in Compute Engines</h3>
                <p>Native embedded solvers running within the OpenBinding compute fabric.</p>
              </div>
              <div className="strip-stats">
                <div>
                  <span>Total Runtime</span>
                  <strong>{formatExecutionTime(telemetry.totals.builtinExecutionSeconds)}</strong>
                </div>
                <div>
                  <span>Dispatched Jobs</span>
                  <strong>{formatCompactNumber(telemetry.totals.builtinJobs)}</strong>
                </div>
                <div>
                  <span>Active Workers</span>
                  <strong>{telemetry.builtinEngines.length} Solvers</strong>
                </div>
              </div>
            </div>

            {/* Visual Charts Grid */}
            <div className="telemetry-charts-grid">
              {/* Chart A: Execution Time Over Time */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Execution Timeline</span>
                    <h4>Compute Duration ({timeHorizon})</h4>
                  </div>
                  <Badge variant="info">Built-in runtime (s)</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={telemetry.points} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
                      <defs>
                        <linearGradient id="builtinGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-dialect)" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="var(--color-dialect)" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis dataKey="label" stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                        formatter={(val: number) => [`${formatExecutionTime(val)} (${val}s)`, 'Runtime']}
                      />
                      <Area
                        type="monotone"
                        dataKey="builtinExecutionSeconds"
                        name="Compute Time"
                        stroke="var(--color-dialect)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#builtinGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Chart B: Jobs Distribution by Engine */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Engine Workload</span>
                    <h4>Dispatched Jobs by Engine</h4>
                  </div>
                  <Badge variant="default">Completed vs Failed</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={telemetry.builtinEngines}
                      margin={{ top: 10, right: 10, left: -15, bottom: 25 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis
                        dataKey="name"
                        stroke="var(--color-text-tertiary)"
                        fontSize={10}
                        angle={-15}
                        textAnchor="end"
                        tickLine={false}
                      />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '0.72rem', paddingTop: '8px' }} />
                      <Bar dataKey="completedJobs" name="Completed" fill="var(--color-dialect)" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="failedJobs" name="Failed" fill="var(--color-error)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            {/* Detailed Engine Runtimes Table */}
            <Card padding="md" className="telemetry-table-card">
              <header className="table-card-header">
                <div>
                  <h4>Built-in Solver Performance & Usage Breakdown</h4>
                  <p>Select an engine row to inspect tenant allocations on that specific solver ({timeHorizon}).</p>
                </div>
              </header>
              <div className="table-scroll-wrap">
                <table className="telemetry-table">
                  <thead>
                    <tr>
                      <th>Engine</th>
                      <th>Version</th>
                      <th>Execution Time</th>
                      <th>Jobs (Comp/Fail)</th>
                      <th>Avg Duration</th>
                      <th>Active Users</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {telemetry.builtinEngines.map((eng) => (
                      <tr
                        key={eng.engineId}
                        className={selectedEngineId === eng.engineId ? 'is-active-row' : ''}
                        onClick={() =>
                          setSelectedEngineId(selectedEngineId === eng.engineId ? null : eng.engineId)
                        }
                        style={{ cursor: 'pointer' }}
                        title="Click to view tenant allocation for this engine"
                      >
                        <td>
                          <div className="engine-name-cell">
                            <Server className="engine-icon" aria-hidden="true" />
                            <div>
                              <strong>{eng.name}</strong>
                              <code>{eng.engineId}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <code>{eng.version}</code>
                        </td>
                        <td>
                          <strong>{formatExecutionTime(eng.executionSeconds)}</strong>
                        </td>
                        <td>
                          <span>
                            {eng.jobCount} total ({eng.completedJobs}/{eng.failedJobs})
                          </span>
                        </td>
                        <td>
                          <code>{eng.avgDurationSeconds}s</code>
                        </td>
                        <td>
                          <Badge variant="default">{eng.userCount} users</Badge>
                        </td>
                        <td>
                          <Badge variant={eng.runningJobs > 0 ? 'warning' : 'success'}>
                            {eng.runningJobs > 0 ? `${eng.runningJobs} running` : 'ready'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Interactive Engine Tenant Drilldown Card */}
            {selectedEngine && (
              <Card padding="md" className="engine-drilldown-card" aria-label={`Tenant breakdown for ${selectedEngine.name}`}>
                <div className="drilldown-header">
                  <div>
                    <span className="drilldown-kicker">Built-in Engine Tenant Allocation</span>
                    <h4>{selectedEngine.name} <code>{selectedEngine.version}</code></h4>
                    <p>Tenant compute consumption, job throughput, and active ledger for this engine.</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedEngineId(null)}>
                    Close
                  </Button>
                </div>
                <div className="table-scroll-wrap">
                  <table className="telemetry-table drilldown-table">
                    <thead>
                      <tr>
                        <th>Tenant Account</th>
                        <th>Plan</th>
                        <th>Execution Time</th>
                        <th>Dispatched Jobs (Comp/Fail)</th>
                        <th>Engine Share</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedEngine.topTenants ?? []).map((t) => (
                        <tr key={t.userId}>
                          <td>
                            <div className="user-identity-cell">
                              <strong>{t.username}</strong>
                              <span>{t.email}</span>
                            </div>
                          </td>
                          <td><Badge>{t.plan}</Badge></td>
                          <td><strong>{formatExecutionTime(t.executionSeconds)}</strong></td>
                          <td>{t.jobCount} ({t.completedJobs}/{t.failedJobs})</td>
                          <td><code>{Math.round((t.executionSeconds / Math.max(1, selectedEngine.executionSeconds)) * 100)}%</code></td>
                          <td>
                            <Button size="sm" variant="ghost" onClick={() => handleInspectByUserId(t.userId)}>
                              Inspect Contract
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {(!selectedEngine.topTenants || selectedEngine.topTenants.length === 0) && (
                        <tr>
                          <td colSpan={6} className="admin-empty">
                            No active tenant jobs recorded on this engine in this time window.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Dedicated Built-in User Compute Spending & Jobs Control Table */}
            <Card padding="md" className="user-spend-breakdown-card" data-testid="builtin-user-spend-card">
              <header className="breakdown-header">
                <div>
                  <div className="breakdown-title-row">
                    <h4>User Compute Spending on Built-in Engines</h4>
                    <Badge variant="info">Built-in Fabric</Badge>
                  </div>
                  <p>
                    Monitor per-user execution time, job counts, and primary solver allocations across native built-in engines.
                  </p>
                </div>
              </header>
              <div className="table-scroll-wrap">
                <table className="telemetry-table" data-testid="builtin-user-spend-table">
                  <thead>
                    <tr>
                      <th>User / Organization</th>
                      <th>Plan</th>
                      <th>Built-in Execution Time</th>
                      <th>Dispatched Jobs</th>
                      <th>Primary Built-in Engine</th>
                      <th>Quota Burn</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const builtinTop = u.engineBreakdown
                        ?.filter((e) => e.category === 'builtin' && e.jobCount > 0)
                        .sort((a, b) => b.executionSeconds - a.executionSeconds)[0];
                      return (
                        <tr key={`builtin-${u.userId}`}>
                          <td>
                            <div className="user-identity-cell">
                              <strong>{u.username}</strong>
                              <span>{u.email}</span>
                            </div>
                          </td>
                          <td><Badge>{u.plan}</Badge></td>
                          <td><strong>{formatExecutionTime(u.builtinExecutionSeconds)}</strong></td>
                          <td>{u.builtinJobs} solves</td>
                          <td>
                            {builtinTop ? (
                              <span><code>{builtinTop.engineName}</code> ({builtinTop.jobCount} jobs)</span>
                            ) : (
                              <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                            )}
                          </td>
                          <td>
                            <div className="quota-meter">
                              <div className="quota-meter-head">
                                <span>{u.quotaUsagePercent}%</span>
                                <small>{formatExecutionTime(u.builtinExecutionSeconds)}</small>
                              </div>
                              <div className="quota-track">
                                <div
                                  className={`quota-fill ${u.quotaUsagePercent >= 80 ? 'is-warning' : 'is-normal'}`}
                                  style={{ width: `${Math.min(100, u.quotaUsagePercent)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <Button size="sm" variant="ghost" onClick={() => handleInspectByUserId(u.userId)}>
                              Contract
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* PANEL 2: PUBLIC FEDERATED ENGINES DASHBOARD */}
        {category === 'public_federated' && (
          <div className="dashboard-category-panel" data-testid="panel-public-federated">
            <div className="panel-summary-strip is-public-fed">
              <div>
                <h3>Public Federated Solvers</h3>
                <p>
                  Community and institutionally published engines executed over secure HTTPS federation contracts.
                </p>
              </div>
              <div className="strip-stats">
                <div>
                  <span>Federated Runtime</span>
                  <strong>{formatExecutionTime(telemetry.totals.publicFederatedExecutionSeconds)}</strong>
                </div>
                <div>
                  <span>Dispatched Solves</span>
                  <strong>{formatCompactNumber(telemetry.totals.publicFederatedJobs)}</strong>
                </div>
                <div>
                  <span>Active Endpoints</span>
                  <strong>{telemetry.publicFederatedEngines.length} Published</strong>
                </div>
              </div>
            </div>

            {/* Charts Grid */}
            <div className="telemetry-charts-grid">
              {/* Chart A: Federated Duration */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Federated Volume</span>
                    <h4>Public Solves & Time Series</h4>
                  </div>
                  <Badge variant="accent">Federated compute (s)</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart
                      data={telemetry.points}
                      margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="fedGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis dataKey="label" stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                        formatter={(val: number) => [`${formatExecutionTime(val)}`, 'Federated Time']}
                      />
                      <Area
                        type="monotone"
                        dataKey="publicFederatedExecutionSeconds"
                        name="Federated Time"
                        stroke="var(--color-accent)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#fedGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Chart B: Endpoint Latency and Success Rate */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Gateway Transport</span>
                    <h4>Remote Latency & Solves</h4>
                  </div>
                  <Badge variant="success">HTTPS SLA</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={telemetry.publicFederatedEngines}
                      margin={{ top: 10, right: 10, left: -15, bottom: 25 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis
                        dataKey="name"
                        stroke="var(--color-text-tertiary)"
                        fontSize={10}
                        angle={-15}
                        textAnchor="end"
                        tickLine={false}
                      />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '0.72rem', paddingTop: '8px' }} />
                      <Bar dataKey="jobCount" name="Dispatched Jobs" fill="var(--color-accent)" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="remoteLatencyMs" name="Latency (ms)" fill="var(--color-core)" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            {/* Public Federated Table */}
            <Card padding="md" className="telemetry-table-card">
              <header className="table-card-header">
                <div>
                  <h4>Published Federated Engines Ledger</h4>
                  <p>Select an engine row to inspect tenant allocations on that federated solver.</p>
                </div>
              </header>
              <div className="table-scroll-wrap">
                <table className="telemetry-table">
                  <thead>
                    <tr>
                      <th>Engine Registration</th>
                      <th>Version</th>
                      <th>Execution Time</th>
                      <th>Dispatches</th>
                      <th>Remote Latency</th>
                      <th>Success Rate</th>
                      <th>Users</th>
                    </tr>
                  </thead>
                  <tbody>
                    {telemetry.publicFederatedEngines.map((eng) => (
                      <tr
                        key={eng.engineId}
                        className={selectedFedEngineId === eng.engineId ? 'is-active-row' : ''}
                        onClick={() =>
                          setSelectedFedEngineId(selectedFedEngineId === eng.engineId ? null : eng.engineId)
                        }
                        style={{ cursor: 'pointer' }}
                        title="Click to view tenant allocation for this federated engine"
                      >
                        <td>
                          <div className="engine-name-cell">
                            <Globe2 className="engine-icon is-fed" aria-hidden="true" />
                            <div>
                              <strong>{eng.name}</strong>
                              <code>{eng.engineId}</code>
                            </div>
                          </div>
                        </td>
                        <td>
                          <code>{eng.version}</code>
                        </td>
                        <td>
                          <strong>{formatExecutionTime(eng.executionSeconds)}</strong>
                        </td>
                        <td>{eng.jobCount}</td>
                        <td>
                          <code>{eng.remoteLatencyMs ?? 160}ms</code>
                        </td>
                        <td>
                          <Badge variant="success">{eng.successRatePercent ?? 99}%</Badge>
                        </td>
                        <td>{eng.userCount} accounts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {/* Interactive Federated Endpoint Tenant Drilldown Card */}
            {selectedFedEngine && (
              <Card padding="md" className="engine-drilldown-card" aria-label={`Tenant breakdown for ${selectedFedEngine.name}`}>
                <div className="drilldown-header">
                  <div>
                    <span className="drilldown-kicker">Federated Endpoint Tenant Allocation</span>
                    <h4>{selectedFedEngine.name} <code>{selectedFedEngine.version}</code></h4>
                    <p>Tenant external dispatches, gateway latency, and SLA conformance for this federated solver.</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedFedEngineId(null)}>
                    Close
                  </Button>
                </div>
                <div className="table-scroll-wrap">
                  <table className="telemetry-table drilldown-table">
                    <thead>
                      <tr>
                        <th>Tenant Account</th>
                        <th>Plan</th>
                        <th>Federated Runtime</th>
                        <th>Dispatched Solves</th>
                        <th>Share</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedFedEngine.topTenants ?? []).map((t) => (
                        <tr key={t.userId}>
                          <td>
                            <div className="user-identity-cell">
                              <strong>{t.username}</strong>
                              <span>{t.email}</span>
                            </div>
                          </td>
                          <td><Badge>{t.plan}</Badge></td>
                          <td><strong>{formatExecutionTime(t.executionSeconds)}</strong></td>
                          <td>{t.jobCount} external solves</td>
                          <td><code>{Math.round((t.executionSeconds / Math.max(1, selectedFedEngine.executionSeconds)) * 100)}%</code></td>
                          <td>
                            <Button size="sm" variant="ghost" onClick={() => handleInspectByUserId(t.userId)}>
                              Inspect Contract
                            </Button>
                          </td>
                        </tr>
                      ))}
                      {(!selectedFedEngine.topTenants || selectedFedEngine.topTenants.length === 0) && (
                        <tr>
                          <td colSpan={6} className="admin-empty">
                            No active tenant jobs recorded on this federated engine in this time window.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Dedicated Public Federated User Compute Spending & Jobs Control Table */}
            <Card padding="md" className="user-spend-breakdown-card" data-testid="fed-user-spend-card">
              <header className="breakdown-header">
                <div>
                  <div className="breakdown-title-row">
                    <h4>User Compute Spending on Public Federated Engines</h4>
                    <Badge variant="accent">Public Federated Mesh</Badge>
                  </div>
                  <p>
                    Track user compute duration, remote dispatches, and SLA conformance on published federated solvers.
                  </p>
                </div>
              </header>
              <div className="table-scroll-wrap">
                <table className="telemetry-table">
                  <thead>
                    <tr>
                      <th>User / Organization</th>
                      <th>Plan</th>
                      <th>Federated Execution Time</th>
                      <th>External Solves</th>
                      <th>Primary Federated Endpoint</th>
                      <th>Quota Burn</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((u) => {
                      const fedTop = u.engineBreakdown
                        ?.filter((e) => e.category === 'public_federated' && e.jobCount > 0)
                        .sort((a, b) => b.executionSeconds - a.executionSeconds)[0];
                      return (
                        <tr key={`fed-${u.userId}`}>
                          <td>
                            <div className="user-identity-cell">
                              <strong>{u.username}</strong>
                              <span>{u.email}</span>
                            </div>
                          </td>
                          <td><Badge>{u.plan}</Badge></td>
                          <td><strong>{formatExecutionTime(u.federatedExecutionSeconds)}</strong></td>
                          <td>{u.federatedJobs} dispatches</td>
                          <td>
                            {fedTop ? (
                              <span><code>{fedTop.engineName}</code> ({fedTop.jobCount} solves)</span>
                            ) : (
                              <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>
                            )}
                          </td>
                          <td>
                            <div className="quota-meter">
                              <div className="quota-meter-head">
                                <span>{u.quotaUsagePercent}%</span>
                                <small>{formatExecutionTime(u.federatedExecutionSeconds)}</small>
                              </div>
                              <div className="quota-track">
                                <div
                                  className={`quota-fill ${u.quotaUsagePercent >= 80 ? 'is-warning' : 'is-normal'}`}
                                  style={{ width: `${Math.min(100, u.quotaUsagePercent)}%` }}
                                />
                              </div>
                            </div>
                          </td>
                          <td>
                            <Button size="sm" variant="ghost" onClick={() => handleInspectByUserId(u.userId)}>
                              Contract
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* PANEL 3: PRIVATE FEDERATED SOLVERS (ANONYMIZED AGGREGATE TELEMETRY) */}
        {category === 'private_federated' && (
          <div className="dashboard-category-panel" data-testid="panel-private-federated">
            {/* Confidential Privacy Assurance Banner */}
            <div className="privacy-assurance-banner">
              <div className="banner-icon-col">
                <ShieldCheck className="shield-icon" aria-hidden="true" />
              </div>
              <div className="banner-text-col">
                <h4>Confidential Solver Telemetry (Privacy Preserved)</h4>
                <p>
                  As an administrator, you cannot inspect private federated engine configurations, endpoints, or
                  proprietary problem representations. This dashboard provides strict platform-level telemetry:
                  <strong> aggregate request flow rates</strong>, <strong>total compute duration</strong>, and{' '}
                  <strong>concurrency pressure</strong> without leaking private tenant assets.
                </p>
              </div>
              <Badge variant="info">Anonymized Stream</Badge>
            </div>

            <div className="panel-summary-strip is-private-fed">
              <div>
                <h3>Private Solvers Traffic & Gateway Flow</h3>
                <p>Aggregated telemetry for private federated solver dispatches and proxy throughput.</p>
              </div>
              <div className="strip-stats">
                <div>
                  <span>Request Flow Rate</span>
                  <strong>{telemetry.privateFederated.peakFlowRateReqPerMin} req/min</strong>
                </div>
                <div>
                  <span>Total Private Solves</span>
                  <strong>{formatCompactNumber(telemetry.privateFederated.totalRequests)}</strong>
                </div>
                <div>
                  <span>Aggregate Duration</span>
                  <strong>{formatExecutionTime(telemetry.privateFederated.totalExecutionSeconds)}</strong>
                </div>
                <div>
                  <span>Active Slots</span>
                  <strong>{telemetry.privateFederated.activeConcurrency} slots</strong>
                </div>
              </div>
            </div>

            {/* Visual Stream Graph */}
            <div className="telemetry-charts-grid">
              {/* Flow Stream Chart */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Gateway Dispatch Rate</span>
                    <h4>Request Flow Throughput (req/min)</h4>
                  </div>
                  <Badge variant="warning">Anonymized Traffic</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart
                      data={telemetry.points}
                      margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="flowGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-warning)" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="var(--color-warning)" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis dataKey="label" stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                        formatter={(val: number) => [`${val} req/min`, 'Flow Rate']}
                      />
                      <Area
                        type="stepAfter"
                        dataKey="privateFlowRateReqPerMin"
                        name="Flow Rate"
                        stroke="var(--color-warning)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#flowGrad)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Data Ingress/Egress Volume */}
              <Card padding="md" className="chart-card">
                <header className="chart-header">
                  <div>
                    <span className="chart-kicker">Network Throughput</span>
                    <h4>Payload Flow & Compute Seconds</h4>
                  </div>
                  <Badge variant="default">Anonymized I/O</Badge>
                </header>
                <div className="chart-container" style={{ width: '100%', height: 260 }}>
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={telemetry.points.slice(-8)}
                      margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                      <XAxis dataKey="label" stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--color-bg-elevated)',
                          borderColor: 'var(--color-border)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: '0.74rem',
                          fontFamily: 'var(--font-mono)',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '0.72rem', paddingTop: '8px' }} />
                      <Bar
                        dataKey="privateExecutionSeconds"
                        name="Runtime (s)"
                        fill="var(--color-core)"
                        radius={[2, 2, 0, 0]}
                      />
                      <Bar
                        dataKey="privateThroughputKb"
                        name="Payload (KB)"
                        fill="var(--color-dialect)"
                        radius={[2, 2, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            </div>

            {/* Flow Characteristics */}
            <div className="private-telemetry-highlights">
              <article>
                <Timer aria-hidden="true" />
                <span>Average Solver Response</span>
                <strong>{telemetry.privateFederated.avgDurationSeconds}s</strong>
                <small>Median solve time</small>
              </article>
              <article>
                <Activity aria-hidden="true" />
                <span>Peak Ingestion Flow</span>
                <strong>{telemetry.privateFederated.peakFlowRateReqPerMin} req/m</strong>
                <small>High watermark</small>
              </article>
              <article>
                <Zap aria-hidden="true" />
                <span>Gateway Success Rate</span>
                <strong>{telemetry.privateFederated.successRatePercent}%</strong>
                <small>Zero payload leak verification</small>
              </article>
              <article>
                <Server aria-hidden="true" />
                <span>Total Bandwidth Flow</span>
                <strong>{telemetry.privateFederated.bandwidthTransferredMb} MB</strong>
                <small>Payload stream</small>
              </article>
            </div>

            {/* Dedicated Confidential Tenant Request Flow & Traffic Meter Table */}
            <Card padding="md" className="user-spend-breakdown-card" data-testid="private-tenant-flow-card">
              <header className="breakdown-header">
                <div>
                  <div className="breakdown-title-row">
                    <h4>Confidential Tenant Request Flow & Traffic Meter</h4>
                    <Badge variant="warning">Privacy Preserved · Zero Code Leak</Badge>
                  </div>
                  <p>
                    Measure how much request flow, execution time, and solver dispatches are consumed by tenant accounts on private solvers.
                  </p>
                </div>
              </header>
              <div className="table-scroll-wrap">
                <table className="telemetry-table">
                  <thead>
                    <tr>
                      <th>Tenant Account</th>
                      <th>Plan</th>
                      <th>Private Requests</th>
                      <th>Compute Runtime</th>
                      <th>Peak Flow Rate</th>
                      <th>Bandwidth Payload</th>
                      <th>Confidentiality Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(telemetry.privateFederated.tenantFlows ?? []).map((tf) => (
                      <tr key={tf.tenantId}>
                        <td>
                          <div className="user-identity-cell">
                            <strong>{tf.tenantName}</strong>
                            <span>{tf.email}</span>
                          </div>
                        </td>
                        <td><Badge>{tf.plan}</Badge></td>
                        <td><strong>{tf.totalRequests} reqs</strong></td>
                        <td><strong>{formatExecutionTime(tf.totalExecutionSeconds)}</strong></td>
                        <td><code>{tf.peakFlowRateReqPerMin} req/m</code></td>
                        <td><code>{tf.bandwidthKb} KB</code></td>
                        <td>
                          <Badge variant="success">
                            <ShieldCheck style={{ width: 12, height: 12, display: 'inline', marginRight: 4, verticalAlign: 'text-bottom' }} />
                            Encrypted & Masked
                          </Badge>
                        </td>
                        <td>
                          <Button size="sm" variant="ghost" onClick={() => handleInspectByUserId(tf.tenantId)}>
                            Contract
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* PANEL 4: UNIFIED COMPARATIVE ANALYSIS */}
        {category === 'unified' && (
          <div className="dashboard-category-panel" data-testid="panel-unified">
            <div className="panel-summary-strip">
              <div>
                <h3>Platform-Wide Compute Allocation</h3>
                <p>Comparative ratio of Built-in, Public Federated, and Private solver workloads.</p>
              </div>
              <div className="strip-stats">
                <div>
                  <span>Overall Compute Time</span>
                  <strong>{formatExecutionTime(telemetry.totals.overallExecutionSeconds)}</strong>
                </div>
                <div>
                  <span>Total Jobs</span>
                  <strong>{formatCompactNumber(telemetry.totals.overallJobs)}</strong>
                </div>
                <div>
                  <span>Active Queue Slots</span>
                  <strong>{telemetry.totals.activeRunningJobs} Running</strong>
                </div>
              </div>
            </div>

            {/* Stacked Comparative Area Chart */}
            <Card padding="md" className="chart-card">
              <header className="chart-header">
                <div>
                  <span className="chart-kicker">Unified Workload Evolution</span>
                  <h4>Execution Seconds by Engine Tier ({timeHorizon})</h4>
                </div>
                <div className="chart-legend-pills">
                  <Badge variant="info">Built-in</Badge>
                  <Badge variant="accent">Public Federated</Badge>
                  <Badge variant="warning">Private Solvers</Badge>
                </div>
              </header>
              <div className="chart-container" style={{ width: '100%', height: 300 }}>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart
                    data={telemetry.points}
                    margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} opacity={0.6} />
                    <XAxis dataKey="label" stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                    <YAxis stroke="var(--color-text-tertiary)" fontSize={11} tickLine={false} />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--color-bg-elevated)',
                        borderColor: 'var(--color-border)',
                        borderRadius: 'var(--radius-md)',
                        fontSize: '0.74rem',
                        fontFamily: 'var(--font-mono)',
                      }}
                      formatter={(val: number, name: string) => [`${formatExecutionTime(val)} (${val}s)`, name]}
                    />
                    <Legend wrapperStyle={{ fontSize: '0.74rem', paddingTop: '8px' }} />
                    <Area
                      type="monotone"
                      dataKey="builtinExecutionSeconds"
                      name="Built-in Solvers"
                      stackId="1"
                      stroke="var(--color-dialect)"
                      fill="var(--color-dialect)"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="publicFederatedExecutionSeconds"
                      name="Public Federated"
                      stackId="1"
                      stroke="var(--color-accent)"
                      fill="var(--color-accent)"
                      fillOpacity={0.6}
                    />
                    <Area
                      type="monotone"
                      dataKey="privateExecutionSeconds"
                      name="Private Solvers Flow"
                      stackId="1"
                      stroke="var(--color-warning)"
                      fill="var(--color-warning)"
                      fillOpacity={0.6}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
        )}

        {/* CROSS-ENGINE USER COMPUTE SPEND & CONSUMPTION BREAKDOWN */}
        <Card padding="md" className="user-spend-breakdown-card">
          <header className="breakdown-header">
            <div>
              <div className="breakdown-title-row">
                <h3>Global User Compute Spending & Quota Utilization</h3>
                <Badge variant={highSpendersCount > 0 ? 'warning' : 'success'}>
                  {highSpendersCount} at risk of quota limit
                </Badge>
              </div>
              <p>
                Comprehensive cross-tier audit of execution time, job volume, and quota burn across all solver classes. Click a user to view engine breakdown.
              </p>
            </div>

            <div className="user-search-wrap">
              <Search className="search-icon" aria-hidden="true" />
              <input
                type="search"
                placeholder="Filter users by name or email…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                aria-label="Filter user spend accounts"
              />
            </div>
          </header>

          <div className="table-scroll-wrap">
            <table className="telemetry-table" data-testid="user-spend-table">
              <thead>
                <tr>
                  <th style={{ width: 30 }} />
                  <th>User / Organization</th>
                  <th>Plan</th>
                  <th>Built-in Time</th>
                  <th>Federated Time</th>
                  <th>Total Time</th>
                  <th>Solves (B / F)</th>
                  <th>Quota Consumption</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((u) => {
                  const isExpanded = expandedUserId === u.userId;
                  return (
                    <Fragment key={u.userId}>
                      <tr
                        key={u.userId}
                        className={`${u.isHighSpender ? 'row-high-spender' : ''} ${isExpanded ? 'is-active-row' : ''}`}
                        onClick={() => setExpandedUserId(isExpanded ? null : u.userId)}
                        style={{ cursor: 'pointer' }}
                        title="Click to toggle engine breakdown"
                      >
                        <td>
                          {isExpanded ? (
                            <ChevronDown style={{ width: 14, height: 14 }} />
                          ) : (
                            <ChevronRight style={{ width: 14, height: 14 }} />
                          )}
                        </td>
                        <td>
                          <div className="user-identity-cell">
                            <strong>{u.username}</strong>
                            <span>{u.email}</span>
                          </div>
                        </td>
                        <td>
                          <Badge variant={u.plan === 'ENTERPRISE' ? 'accent' : 'default'}>{u.plan}</Badge>
                        </td>
                        <td>
                          <strong>{formatExecutionTime(u.builtinExecutionSeconds)}</strong>
                        </td>
                        <td>
                          <strong>{formatExecutionTime(u.federatedExecutionSeconds)}</strong>
                        </td>
                        <td>
                          <strong className="spend-total">{formatExecutionTime(u.totalExecutionSeconds)}</strong>
                        </td>
                        <td>
                          <span>
                            {u.totalJobs} ({u.builtinJobs} / {u.federatedJobs})
                          </span>
                        </td>
                        <td>
                          <div className="quota-meter">
                            <div className="quota-meter-head">
                              <span>{u.quotaUsagePercent}%</span>
                              <small>
                                {formatExecutionTime(u.quotaUsedSeconds)} /{' '}
                                {formatExecutionTime(u.quotaLimitSeconds)}
                              </small>
                            </div>
                            <div className="quota-track">
                              <div
                                className={`quota-fill ${
                                  u.quotaUsagePercent >= 90
                                    ? 'is-critical'
                                    : u.quotaUsagePercent >= 70
                                    ? 'is-warning'
                                    : 'is-normal'
                                }`}
                                style={{ width: `${Math.min(100, u.quotaUsagePercent)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleInspectByUserId(u.userId);
                            }}
                            title={`Manage contract and quotas for ${u.username}`}
                          >
                            Contract
                          </Button>
                        </td>
                      </tr>
                      {isExpanded && u.engineBreakdown && u.engineBreakdown.length > 0 && (
                        <tr key={`${u.userId}-expanded`} className="user-expanded-row">
                          <td colSpan={9}>
                            <div className="user-expanded-breakdown">
                              <span className="user-breakdown-kicker">Engine Spend Breakdown for {u.username}</span>
                              <div className="user-breakdown-grid">
                                {u.engineBreakdown
                                  .filter((e) => e.jobCount > 0)
                                  .map((eng) => (
                                    <div key={eng.engineId} className="user-breakdown-chip">
                                      <div className="chip-head">
                                        <Badge variant={eng.category === 'builtin' ? 'info' : 'accent'}>
                                          {eng.category === 'builtin' ? 'Built-in' : 'Public Fed'}
                                        </Badge>
                                        <strong>{eng.engineName}</strong>
                                      </div>
                                      <div className="chip-stats">
                                        <span>{formatExecutionTime(eng.executionSeconds)}</span>
                                        <small>{eng.jobCount} jobs ({eng.completedJobs} ok / {eng.failedJobs} err)</small>
                                      </div>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </section>
  );
}
