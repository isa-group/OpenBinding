import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  Radio,
  RefreshCw,
  Search,
  Check,
  Copy,
  X,
  Clock,
  ShieldAlert,
  Server,
  Zap,
  Layers,
  ArrowUpRight,
  Filter,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { apiClient } from '../../api/client';
import type {
  AdminErrorOverview,
  AdminErrorListResponse,
  ApiErrorEventItem,
} from './types';

type DiagnosticTab = 'pricing_quota' | 'solver_failure' | 'system_bug' | 'validation' | 'all';

interface AdminErrorDiagnosticsProps {
  onInspectUser?: (userId: string) => void;
}

export const AdminErrorDiagnostics: React.FC<AdminErrorDiagnosticsProps> = ({
  onInspectUser,
}) => {
  const [overview, setOverview] = useState<AdminErrorOverview | null>(null);
  const [errorList, setErrorList] = useState<AdminErrorListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // Active filter tab
  const [activeTab, setActiveTab] = useState<DiagnosticTab>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusCodeFilter, setStatusCodeFilter] = useState<string>('all');

  // Selected error for side drawer inspector
  const [inspectingEvent, setInspectingEvent] = useState<ApiErrorEventItem | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setErrorNotice(null);

    try {
      const [overviewData, listData] = await Promise.all([
        apiClient.adminErrorOverview(),
        apiClient.adminListErrors({
          category: activeTab !== 'all' ? activeTab : undefined,
          status_code: statusCodeFilter !== 'all' ? parseInt(statusCodeFilter, 10) : undefined,
          search: searchQuery.trim() || undefined,
          limit: 100,
        }),
      ]);
      setOverview(overviewData);
      setErrorList(listData);
    } catch (err: unknown) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to fetch error diagnostics telemetry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab, statusCodeFilter, searchQuery]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Handle drawer copy action
  const handleCopyJson = () => {
    if (!inspectingEvent) return;
    const payload = JSON.stringify(inspectingEvent, null, 2);
    void navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // KPIs derived from overview
  const kpis = useMemo(() => {
    const total = overview?.total_errors_24h || 0;
    const cat = overview?.by_category_24h || {};
    const quotaCount = cat['pricing_quota'] !== undefined ? cat['pricing_quota'] : (overview?.by_status_code_24h?.['402'] || 0);
    const concurrencyCount = cat['concurrency'] !== undefined ? cat['concurrency'] : (overview?.by_status_code_24h?.['429'] || 0);
    const solverCount = cat['solver_failure'] || 0;
    const systemCount = cat['system_bug'] !== undefined ? cat['system_bug'] : ((overview?.by_status_code_24h?.['500'] || 0) + (overview?.by_status_code_24h?.['503'] || 0));
    const validationCount = cat['validation'] || 0;

    return {
      total,
      quotaCount,
      concurrencyCount,
      solverCount,
      systemCount,
      validationCount,
    };
  }, [overview]);

  // Chart data formatting
  const chartData = useMemo(() => {
    if (!overview?.timeline) return [];
    return overview.timeline.map((point) => {
      const d = new Date(point.timestamp);
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return {
        time: timeStr,
        Quota: point.quota || 0,
        Concurrency: point.concurrency || 0,
        Solver: point.solver || 0,
        System: point.system || 0,
        Validation: point.validation || 0,
      };
    });
  }, [overview]);

  const renderBadge = (statusCode: number, category: string) => {
    let colorClass = 'badge-system';
    if (statusCode === 402 || category === 'pricing_quota') colorClass = 'badge-quota';
    else if (statusCode === 429 || category === 'concurrency') colorClass = 'badge-concurrency';
    else if (category === 'solver_failure') colorClass = 'badge-solver';
    else if (statusCode === 422 || category === 'validation') colorClass = 'badge-validation';

    return <span className={`error-status-badge ${colorClass}`}>{statusCode}</span>;
  };

  return (
    <div className="admin-error-diagnostics">
      {/* Diagnostics Header Strip */}
      <div className="diagnostics-header-strip">
        <div>
          <div className="diagnostics-kicker">
            <Radio aria-hidden="true" style={{ width: 14, height: 14, color: '#f59e0b' }} />
            <span>INCIDENT LOG & TELEMETRY OBSERVABILITY</span>
          </div>
          <h2 className="diagnostics-title">Quota, Concurrency & Incident Diagnostics</h2>
          <p className="diagnostics-subtitle">
            Authoritative trace of 402 quota exhaustion, 429 concurrency throttles, solver terminations, and infrastructure faults.
          </p>
        </div>
        <div className="diagnostics-actions">
          <button
            type="button"
            className="diagnostics-refresh-btn"
            onClick={() => void loadData(true)}
            disabled={refreshing}
            title="Refresh error telemetry"
          >
            <RefreshCw
              aria-hidden="true"
              style={{
                width: 14,
                height: 14,
                animation: refreshing ? 'spin 1s linear infinite' : 'none',
              }}
            />
            {refreshing ? 'Syncing...' : 'Sync Telemetry'}
          </button>
        </div>
      </div>

      {errorNotice && (
        <div className="diagnostics-alert-banner">
          <AlertTriangle aria-hidden="true" style={{ width: 16, height: 16 }} />
          <span>{errorNotice}</span>
        </div>
      )}

      {/* KPI Cards Strip */}
      <div className="diagnostics-kpi-grid">
        {/* Card 1: 402 Quota */}
        <div
          className={`diagnostics-kpi-card is-quota ${activeTab === 'pricing_quota' ? 'is-selected' : ''}`}
          onClick={() => setActiveTab('pricing_quota')}
          role="button"
          tabIndex={0}
        >
          <div className="kpi-card-header">
            <span className="kpi-tag kpi-tag-quota">402 PAYMENT REQUIRED</span>
            <span className="kpi-ratio">
              {kpis.total > 0 ? Math.round((kpis.quotaCount / kpis.total) * 100) : 0}% total
            </span>
          </div>
          <div className="kpi-card-body">
            <div className="kpi-value">{kpis.quotaCount}</div>
            <div className="kpi-label">Commercial Quotas Spent</div>
          </div>
          <div className="kpi-card-footer">
            <span>Periodic taskStarts, solver seconds & storage limits</span>
          </div>
        </div>

        {/* Card 2: 429 Concurrency */}
        <div
          className={`diagnostics-kpi-card is-concurrency ${activeTab === 'all' && statusCodeFilter === '429' ? 'is-selected' : ''}`}
          onClick={() => {
            setActiveTab('all');
            setStatusCodeFilter('429');
          }}
          role="button"
          tabIndex={0}
        >
          <div className="kpi-card-header">
            <span className="kpi-tag kpi-tag-concurrency">429 TOO MANY REQUESTS</span>
            <span className="kpi-ratio">
              {kpis.total > 0 ? Math.round((kpis.concurrencyCount / kpis.total) * 100) : 0}% total
            </span>
          </div>
          <div className="kpi-card-body">
            <div className="kpi-value">{kpis.concurrencyCount}</div>
            <div className="kpi-label">Concurrency Slots Full</div>
          </div>
          <div className="kpi-card-footer">
            <span>concurrentJobs saturations (Retry-After: 15s)</span>
          </div>
        </div>

        {/* Card 3: Solver Failures */}
        <div
          className={`diagnostics-kpi-card is-solver ${activeTab === 'solver_failure' ? 'is-selected' : ''}`}
          onClick={() => setActiveTab('solver_failure')}
          role="button"
          tabIndex={0}
        >
          <div className="kpi-card-header">
            <span className="kpi-tag kpi-tag-solver">
              <span className="pulse-dot" /> SOLVER CRASHES
            </span>
            <span className="kpi-ratio">
              {kpis.total > 0 ? Math.round((kpis.solverCount / kpis.total) * 100) : 0}% total
            </span>
          </div>
          <div className="kpi-card-body">
            <div className="kpi-value">{kpis.solverCount}</div>
            <div className="kpi-label">Job Execution Failures</div>
          </div>
          <div className="kpi-card-footer">
            <span>Engines terminating with UNKNOWN or crashed state</span>
          </div>
        </div>

        {/* Card 4: System Bugs */}
        <div
          className={`diagnostics-kpi-card is-system ${activeTab === 'system_bug' ? 'is-selected' : ''}`}
          onClick={() => setActiveTab('system_bug')}
          role="button"
          tabIndex={0}
        >
          <div className="kpi-card-header">
            <span className="kpi-tag kpi-tag-system">5xx / 503 SYSTEM</span>
            <span className="kpi-ratio">
              {kpis.total > 0 ? Math.round((kpis.systemCount / kpis.total) * 100) : 0}% total
            </span>
          </div>
          <div className="kpi-card-body">
            <div className="kpi-value">{kpis.systemCount}</div>
            <div className="kpi-label">Platform & Upstream Faults</div>
          </div>
          <div className="kpi-card-footer">
            <span>SPACE unavailable, internal runtime or DB exceptions</span>
          </div>
        </div>
      </div>

      {/* Temporal Evolution Chart */}
      <div className="diagnostics-chart-section">
        <div className="chart-section-header">
          <div>
            <h3 className="chart-title">Error Distribution & Ingestion Velocity (24 Hours)</h3>
            <p className="chart-subtitle">
              Stacked hourly breakdown comparing pricing refusals versus operational engine crashes.
            </p>
          </div>
          <div className="chart-legend-strip">
            <span className="legend-chip legend-quota"><span className="chip-dot" /> 402 Quota</span>
            <span className="legend-chip legend-concurrency"><span className="chip-dot" /> 429 Concurrency</span>
            <span className="legend-chip legend-solver"><span className="chip-dot" /> Solver Crash</span>
            <span className="legend-chip legend-system"><span className="chip-dot" /> 5xx System</span>
            <span className="legend-chip legend-validation"><span className="chip-dot" /> 422 Validation</span>
          </div>
        </div>

        <div className="diagnostics-chart-wrapper" style={{ width: '100%', height: 260 }}>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorQuota" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="colorConcurrency" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="colorSolver" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="colorSystem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ec4899" stopOpacity={0.8} />
                    <stop offset="95%" stopColor="#ec4899" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0f172a',
                    borderColor: '#334155',
                    color: '#f8fafc',
                    borderRadius: '6px',
                    fontSize: '12px',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
                  }}
                />
                <Area type="monotone" dataKey="Quota" stackId="1" stroke="#f59e0b" fill="url(#colorQuota)" />
                <Area type="monotone" dataKey="Concurrency" stackId="1" stroke="#6366f1" fill="url(#colorConcurrency)" />
                <Area type="monotone" dataKey="Solver" stackId="1" stroke="#ef4444" fill="url(#colorSolver)" />
                <Area type="monotone" dataKey="System" stackId="1" stroke="#ec4899" fill="url(#colorSystem)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="diagnostics-chart-empty">No telemetry events in the last 24 hours.</div>
          )}
        </div>
      </div>

      {/* Thematic Tabs Navigation */}
      <div className="diagnostics-tabs-bar">
        <button
          type="button"
          className={`diag-tab-btn ${activeTab === 'all' ? 'is-active' : ''}`}
          onClick={() => {
            setActiveTab('all');
            setStatusCodeFilter('all');
          }}
        >
          <Layers aria-hidden="true" style={{ width: 14, height: 14 }} />
          All Events ({errorList?.total || 0})
        </button>
        <button
          type="button"
          className={`diag-tab-btn ${activeTab === 'pricing_quota' ? 'is-active' : ''}`}
          onClick={() => {
            setActiveTab('pricing_quota');
            setStatusCodeFilter('all');
          }}
        >
          <Zap aria-hidden="true" style={{ width: 14, height: 14 }} />
          Pricing & Quotas (402)
        </button>
        <button
          type="button"
          className={`diag-tab-btn ${activeTab === 'solver_failure' ? 'is-active' : ''}`}
          onClick={() => {
            setActiveTab('solver_failure');
            setStatusCodeFilter('all');
          }}
        >
          <Server aria-hidden="true" style={{ width: 14, height: 14 }} />
          Solver Crashes
        </button>
        <button
          type="button"
          className={`diag-tab-btn ${activeTab === 'system_bug' ? 'is-active' : ''}`}
          onClick={() => {
            setActiveTab('system_bug');
            setStatusCodeFilter('all');
          }}
        >
          <ShieldAlert aria-hidden="true" style={{ width: 14, height: 14 }} />
          System & Infra (5xx)
        </button>
        <button
          type="button"
          className={`diag-tab-btn ${activeTab === 'validation' ? 'is-active' : ''}`}
          onClick={() => {
            setActiveTab('validation');
            setStatusCodeFilter('all');
          }}
        >
          <Filter aria-hidden="true" style={{ width: 14, height: 14 }} />
          Validation (422)
        </button>
      </div>

      {/* Top Prospecting / Refused Users Strip (Visible on Pricing or All tab) */}
      {(activeTab === 'all' || activeTab === 'pricing_quota') && overview?.top_users_quota && overview.top_users_quota.length > 0 && (
        <div className="top-quota-prospects-strip">
          <div className="strip-title">
            <Zap aria-hidden="true" style={{ width: 14, height: 14, color: '#f59e0b' }} />
            <span>Commercial Upgrade Signals: High-Quota Saturation Accounts</span>
          </div>
          <div className="prospects-pill-list">
            {overview.top_users_quota.map((user) => (
              <div key={user.userId} className="prospect-pill">
                <div className="prospect-main">
                  <span className="prospect-email">{user.email || user.userId.slice(0, 8)}</span>
                  <span className="prospect-count">{user.errorCount} refusals</span>
                </div>
                {onInspectUser && (
                  <button
                    type="button"
                    className="prospect-inspect-link"
                    onClick={() => onInspectUser(user.userId)}
                    title="Inspect user subscription"
                  >
                    Novate Plan <ArrowUpRight aria-hidden="true" style={{ width: 12, height: 12 }} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters Strip */}
      <div className="diagnostics-filters-strip">
        <div className="search-box">
          <Search aria-hidden="true" style={{ width: 14, height: 14, color: '#94a3b8' }} />
          <input
            type="text"
            placeholder="Filter by endpoint, error code, user email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="clear-search-btn"
              onClick={() => setSearchQuery('')}
            >
              <X aria-hidden="true" style={{ width: 12, height: 12 }} />
            </button>
          )}
        </div>

        <div className="status-filter-select">
          <label htmlFor="diag-status-select">Status:</label>
          <select
            id="diag-status-select"
            value={statusCodeFilter}
            onChange={(e) => setStatusCodeFilter(e.target.value)}
          >
            <option value="all">All HTTP Codes</option>
            <option value="402">402 Payment Required</option>
            <option value="429">429 Too Many Requests</option>
            <option value="422">422 Unprocessable Content</option>
            <option value="403">403 Forbidden</option>
            <option value="401">401 Unauthorized</option>
            <option value="500">500 Internal Server Error</option>
            <option value="503">503 Service Unavailable</option>
          </select>
        </div>
      </div>

      {/* Incident Log Table */}
      <div className="diagnostics-table-container">
        <table className="diagnostics-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Category</th>
              <th>Error Code</th>
              <th>Method & Endpoint</th>
              <th>Caller / Tenant</th>
              <th>Recorded At</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="table-loading-cell">
                  Loading error diagnostics events...
                </td>
              </tr>
            ) : errorList?.items?.length ? (
              errorList.items.map((event: ApiErrorEventItem) => {
                const date = new Date(event.createdAt || event.created_at);
                const timeAgo = date.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                const userDisplay = event.userEmail || event.user_email || (event.userId || event.user_id ? `${(event.userId || event.user_id)!.slice(0, 8)}...` : 'Anonymous');

                return (
                  <tr
                    key={event.id}
                    className="diagnostics-row"
                    onClick={() => setInspectingEvent(event)}
                  >
                    <td>{renderBadge(event.statusCode || event.status_code, event.category)}</td>
                    <td>
                      <span className="mono-category-badge">{event.category}</span>
                    </td>
                    <td>
                      <code className="mono-code-badge">{event.errorCode || event.error_code}</code>
                    </td>
                    <td>
                      <div className="endpoint-cell">
                        <span className="method-tag">{event.httpMethod || event.http_method}</span>
                        <span className="endpoint-path" title={event.endpoint}>
                          {event.endpoint}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="caller-text" title={event.userId || event.user_id || undefined}>
                        {userDisplay}
                      </span>
                    </td>
                    <td>
                      <div className="time-cell">
                        <Clock aria-hidden="true" style={{ width: 12, height: 12, color: '#94a3b8' }} />
                        <span>{timeAgo}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="inspect-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setInspectingEvent(event);
                        }}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7} className="table-empty-cell">
                  No incident logs match the active filter criteria.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer: Error Inspector */}
      {inspectingEvent && (
        <div className="error-inspector-drawer-backdrop" onClick={() => setInspectingEvent(null)}>
          <aside
            className="error-inspector-drawer"
            onClick={(e) => e.stopPropagation()}
            aria-label="Root Cause Error Inspector"
          >
            <div className="drawer-header">
              <div>
                <span className="drawer-kicker">INCIDENT INSPECTOR</span>
                <h3 className="drawer-title">
                  {inspectingEvent.errorCode || inspectingEvent.error_code}
                </h3>
              </div>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => setInspectingEvent(null)}
                title="Close drawer"
              >
                <X aria-hidden="true" style={{ width: 16, height: 16 }} />
              </button>
            </div>

            <div className="drawer-metadata-grid">
              <div className="meta-item">
                <span className="meta-label">HTTP Status</span>
                <div className="meta-val">
                  {renderBadge(inspectingEvent.statusCode || inspectingEvent.status_code, inspectingEvent.category)}
                </div>
              </div>
              <div className="meta-item">
                <span className="meta-label">Category</span>
                <span className="meta-val mono-category-badge">{inspectingEvent.category}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Method & Path</span>
                <span className="meta-val mono-val">
                  {inspectingEvent.httpMethod || inspectingEvent.http_method} {inspectingEvent.endpoint}
                </span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Timestamp</span>
                <span className="meta-val">{new Date(inspectingEvent.createdAt || inspectingEvent.created_at).toLocaleString()}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">User / Account ID</span>
                <span className="meta-val mono-val">{inspectingEvent.userId || inspectingEvent.user_id || 'None (Anonymous)'}</span>
              </div>
              {inspectingEvent.userEmail || inspectingEvent.user_email ? (
                <div className="meta-item">
                  <span className="meta-label">User Email</span>
                  <span className="meta-val">{inspectingEvent.userEmail || inspectingEvent.user_email}</span>
                </div>
              ) : null}
            </div>

            {/* Quota / Concurrency Breakdown if present */}
            {inspectingEvent.detail?.quota && (
              <div className="drawer-quota-breakdown">
                <div className="breakdown-header">
                  <Zap aria-hidden="true" style={{ width: 14, height: 14, color: '#f59e0b' }} />
                  <span>Quota Breakdown: {inspectingEvent.detail.quota.limit_id}</span>
                </div>
                <div className="quota-bar-row">
                  <div className="quota-values">
                    <span>Used: {inspectingEvent.detail.quota.used}</span>
                    <span>Allowance: {inspectingEvent.detail.quota.limit} {inspectingEvent.detail.quota.unit || ''}</span>
                  </div>
                  <div className="quota-progress-track">
                    <div
                      className="quota-progress-fill"
                      style={{
                        width: `${Math.min(100, (inspectingEvent.detail.quota.used / inspectingEvent.detail.quota.limit) * 100)}%`,
                      }}
                    />
                  </div>
                  {inspectingEvent.detail.quota.renews_at && (
                    <div className="quota-renew-text">
                      Slate resets on: {new Date(inspectingEvent.detail.quota.renews_at).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Raw JSON Diagnostic Payload */}
            <div className="drawer-json-section">
              <div className="json-header">
                <span>STRUCTURED DIAGNOSTIC PAYLOAD</span>
                <button
                  type="button"
                  className="copy-json-btn"
                  onClick={handleCopyJson}
                >
                  {copied ? (
                    <>
                      <Check aria-hidden="true" style={{ width: 12, height: 12, color: '#10b981' }} />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy aria-hidden="true" style={{ width: 12, height: 12 }} />
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="diagnostic-json-viewer">
                {JSON.stringify(inspectingEvent.detail, null, 2)}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
};
