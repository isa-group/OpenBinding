import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Cpu,
  HelpCircle,
  Layers,
  RefreshCw,
  RotateCcw,
  Scale,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import {
  apiClient,
  type AdaptationObservationItem,
  type EngineRoutingMetricSnapshot,
  type EngineRoutingMetricsResponse,
  type EngineRoutingRecalibrateResponse,
} from '../../api/client';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Alert } from '../../components/ui/Alert';

export function AdminAutoRouter() {
  const [metrics, setMetrics] = useState<EngineRoutingMetricsResponse | null>(null);
  const [observations, setObservations] = useState<AdaptationObservationItem[]>([]);
  const [totalObs, setTotalObs] = useState(0);
  const [obsOffset, setObsOffset] = useState(0);
  const [selectedEngineFilter, setSelectedEngineFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [recalibrating, setRecalibrating] = useState(false);
  const [recalibrateResult, setRecalibrateResult] = useState<EngineRoutingRecalibrateResponse | null>(null);
  const [expandedObsId, setExpandedObsId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const PAGE_SIZE = 15;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mRes, oRes] = await Promise.all([
        apiClient.adminGetEngineRoutingMetrics().catch((err) => {
          console.warn('Metrics failed to load:', err);
          return null;
        }),
        apiClient.adminListEngineRoutingObservations({
          engine: selectedEngineFilter || undefined,
          limit: PAGE_SIZE,
          offset: obsOffset,
        }).catch((err) => {
          console.warn('Observations failed to load:', err);
          return { total: 0, limit: PAGE_SIZE, offset: 0, observations: [] };
        }),
      ]);

      if (mRes) setMetrics(mRes);
      if (oRes) {
        setObservations(oRes.observations || []);
        setTotalObs(oRes.total || 0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AutoRouter telemetry.');
    } finally {
      setLoading(false);
    }
  }, [selectedEngineFilter, obsOffset]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRecalibrate = async () => {
    setRecalibrating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiClient.adminRecalibrateEngineRouting();
      setRecalibrateResult(res);
      setNotice(
        `Recalibration complete: ${res.observationsProcessed} observation(s) processed. Calibrated engines: ${
          res.calibratedEngines.length > 0 ? res.calibratedEngines.join(', ') : 'None'
        }.`
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recalibration failed.');
    } finally {
      setRecalibrating(false);
    }
  };

  const engines = metrics?.engines ? Object.entries(metrics.engines) : [];

  return (
    <div className="admin-operations-container" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header with Title and Recalibrate Trigger */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          paddingBottom: '1rem',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Compass size={22} color="var(--color-primary)" />
            <h2 style={{ margin: 0, fontSize: '1.4rem' }}>AutoRouter · Autonomic MAPE-K Controller</h2>
            <Badge variant="info">Self-Adaptive</Badge>
          </div>
          <p style={{ margin: '0.25rem 0 0 0', color: 'var(--color-muted)', fontSize: '0.9rem' }}>
            Monitor solver runtime health, detect CUSUM concept drift, inspect adaptation observations, and recalibrate predictive models.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Button
            variant="secondary"
            onClick={() => void loadData()}
            disabled={loading}
            title="Refresh telemetry"
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> Refresh
          </Button>
          <Button
            variant="primary"
            onClick={handleRecalibrate}
            disabled={recalibrating || loading}
            title="Trigger autonomic model recalibration using historical residuals"
          >
            <Sparkles size={15} className={recalibrating ? 'spin' : ''} />
            {recalibrating ? 'Recalibrating…' : 'Recalibrate Models'}
          </Button>
        </div>
      </div>

      {/* Notices and Alerts */}
      {notice && (
        <Alert variant="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert variant="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* KPI Overview Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
        }}
      >
        <Card style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-muted)', fontSize: '0.85rem' }}>
            <Layers size={16} /> Total Monitored Engines
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', marginTop: '0.35rem' }}>
            {metrics?.summary?.totalEngines ?? engines.length}
          </div>
          <small style={{ color: 'var(--color-muted)' }}>Registered solver candidates</small>
        </Card>

        <Card style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-success)', fontSize: '0.85rem' }}>
            <CheckCircle2 size={16} /> Healthy Engines
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', marginTop: '0.35rem', color: 'var(--color-success)' }}>
            {metrics?.summary?.healthyEngines ?? engines.filter(([, e]) => e.healthStatus === 'HEALTHY').length}
          </div>
          <small style={{ color: 'var(--color-muted)' }}>Within operating thresholds</small>
        </Card>

        <Card style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-error)', fontSize: '0.85rem' }}>
            <AlertTriangle size={16} /> Degraded / Trips
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', marginTop: '0.35rem', color: 'var(--color-error)' }}>
            {metrics?.summary?.degradedEngines ?? engines.filter(([, e]) => e.healthStatus === 'DEGRADED').length}
          </div>
          <small style={{ color: 'var(--color-muted)' }}>Circuit breaker or timeout trips</small>
        </Card>

        <Card style={{ padding: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--color-primary)', fontSize: '0.85rem' }}>
            <Activity size={16} /> Active Routing Concurrency
          </div>
          <div style={{ fontSize: '1.8rem', fontWeight: 'bold', marginTop: '0.35rem' }}>
            {metrics?.summary?.activeJobs ?? 0}
          </div>
          <small style={{ color: 'var(--color-muted)' }}>In-flight solver executions</small>
        </Card>
      </div>

      {/* Engine Health and CUSUM Drift Monitor */}
      <Card style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Candidate Engines Health & Statistical Drift (CUSUM)</h3>
            <p style={{ margin: '0.2rem 0 0 0', color: 'var(--color-muted)', fontSize: '0.85rem' }}>
              Real-time autonomic monitoring of solver availability, empirical observation confidence, and cumulative drift alarms.
            </p>
          </div>
          <Badge variant="default">MAPE-K Monitor</Badge>
        </div>

        {engines.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-muted)' }}>
            No engine metrics reported yet. Execute a job with <code>engine: "auto"</code> to initialize telemetry.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-muted)' }}>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Engine Name</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Health Status</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Availability</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Confidence (γ)</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>1h Failure Rate</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Avg Latency</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Active Jobs</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>CUSUM Drift</th>
                </tr>
              </thead>
              <tbody>
                {engines.map(([engineId, snapshot]) => {
                  const isHealthy = snapshot.healthStatus === 'HEALTHY';
                  const hasAlarm = Boolean(snapshot.driftAlarm);
                  return (
                    <tr key={engineId} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                      <td style={{ padding: '0.75rem', fontWeight: 600 }}>
                        <code>{engineId}</code>
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        <Badge variant={isHealthy ? 'success' : 'error'}>
                          {snapshot.healthStatus || 'UNKNOWN'}
                        </Badge>
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {snapshot.available ? (
                          <span style={{ color: 'var(--color-success)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <CheckCircle2 size={13} /> Online
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-error)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                            <AlertTriangle size={13} /> Offline
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span>{((snapshot.confidence ?? 0.5) * 100).toFixed(0)}%</span>
                          <div
                            style={{
                              width: '50px',
                              height: '6px',
                              backgroundColor: 'var(--color-border)',
                              borderRadius: '3px',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.min(100, Math.max(0, (snapshot.confidence ?? 0.5) * 100))}%`,
                                height: '100%',
                                backgroundColor:
                                  (snapshot.confidence ?? 0.5) > 0.7
                                    ? 'var(--color-success)'
                                    : (snapshot.confidence ?? 0.5) > 0.4
                                    ? 'var(--color-warning)'
                                    : 'var(--color-error)',
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {snapshot.oneHourFailureRate != null
                          ? `${(snapshot.oneHourFailureRate * 100).toFixed(1)}%`
                          : '0.0%'}
                      </td>
                      <td style={{ padding: '0.75rem' }}>
                        {snapshot.avgLatency != null ? `${snapshot.avgLatency.toFixed(2)}s` : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem' }}>{snapshot.activeJobs ?? 0}</td>
                      <td style={{ padding: '0.75rem' }}>
                        {hasAlarm ? (
                          <Badge variant="warning">
                            <AlertTriangle size={12} style={{ marginRight: '0.25rem' }} />
                            DRIFT ALARM
                          </Badge>
                        ) : (
                          <span style={{ color: 'var(--color-muted)', fontSize: '0.85rem' }}>
                            Stable (S⁺: {snapshot.cusumSPlus?.toFixed(2) ?? '0.00'})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Historical MAPE-K Adaptation Observations Log */}
      <Card style={{ padding: '1.25rem' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
            marginBottom: '1rem',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Historical Adaptation Observations</h3>
            <p style={{ margin: '0.2rem 0 0 0', color: 'var(--color-muted)', fontSize: '0.85rem' }}>
              Persistent Knowledge store of workload vectors, multi-criteria evaluations, and execution residuals.
            </p>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              Filter by Engine:
              <select
                value={selectedEngineFilter}
                onChange={(e) => {
                  setSelectedEngineFilter(e.target.value);
                  setObsOffset(0);
                }}
                style={{
                  padding: '0.35rem 0.5rem',
                  borderRadius: '4px',
                  border: '1px solid var(--color-border)',
                  backgroundColor: 'var(--color-surface)',
                  color: 'inherit',
                }}
              >
                <option value="">All Engines</option>
                {engines.map(([eId]) => (
                  <option key={eId} value={eId}>
                    {eId}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {observations.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--color-muted)' }}>
            No adaptation observations recorded yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-muted)' }}>
                    <th style={{ padding: '0.5rem' }}>Recorded At</th>
                    <th style={{ padding: '0.5rem' }}>Engine Selected</th>
                    <th style={{ padding: '0.5rem' }}>Outcome</th>
                    <th style={{ padding: '0.5rem' }}>Workload Vector</th>
                    <th style={{ padding: '0.5rem' }}>Residuals (Δ Latency / Δ Quality)</th>
                    <th style={{ padding: '0.5rem', textAlign: 'right' }}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((obs) => {
                    const isExpanded = expandedObsId === obs.id;
                    const wf = obs.workloadFeatures || {};
                    const res = obs.residuals || {};
                    const isSuccess = obs.outcome === 'success';

                    return (
                      <Fragment key={obs.id}>
                        <tr style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--color-border-subtle)' }}>
                          <td style={{ padding: '0.6rem 0.5rem', whiteSpace: 'nowrap', color: 'var(--color-muted)' }}>
                            {obs.createdAt ? new Date(obs.createdAt).toLocaleString() : 'N/A'}
                          </td>
                          <td style={{ padding: '0.6rem 0.5rem', fontWeight: 600 }}>
                            <code>{obs.engineSelected}</code>
                          </td>
                          <td style={{ padding: '0.6rem 0.5rem' }}>
                            <Badge variant={isSuccess ? 'success' : 'error'}>
                              {obs.outcome.toUpperCase()}
                            </Badge>
                          </td>
                          <td style={{ padding: '0.6rem 0.5rem' }}>
                            <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                              S={typeof wf.S === 'number' ? wf.S.toFixed(1) : wf.S ?? '—'}, D_c=
                              {typeof wf.D_constr === 'number' ? wf.D_constr.toFixed(2) : wf.D_constr ?? '—'}, Tasks=
                              {wf.N_tasks ?? '—'}
                            </span>
                          </td>
                          <td style={{ padding: '0.6rem 0.5rem' }}>
                            <span style={{ fontSize: '0.8rem', color: 'var(--color-muted)' }}>
                              ΔL: {typeof res.latency === 'number' ? `${res.latency > 0 ? '+' : ''}${res.latency.toFixed(2)}s` : '0.00s'} ·
                              ΔQ: {typeof res.quality === 'number' ? `${res.quality > 0 ? '+' : ''}${res.quality.toFixed(2)}` : '0.00'}
                            </span>
                          </td>
                          <td style={{ padding: '0.6rem 0.5rem', textAlign: 'right' }}>
                            <Button
                              variant="secondary"
                              size="small"
                              onClick={() => setExpandedObsId(isExpanded ? null : obs.id)}
                            >
                              {isExpanded ? 'Hide' : 'Inspect'}
                            </Button>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr>
                            <td colSpan={6} style={{ padding: '1rem', backgroundColor: 'var(--color-surface-subtle)' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                                  <div>
                                    <strong>Adaptation Loop ID:</strong> <code>{obs.adaptationLoopId}</code>
                                  </div>
                                  {obs.jobId && (
                                    <div>
                                      <strong>Job ID:</strong> <code>{obs.jobId}</code>
                                    </div>
                                  )}
                                </div>

                                {/* Candidate Evaluations Breakdown */}
                                {obs.candidateEvaluations && obs.candidateEvaluations.length > 0 && (
                                  <div>
                                    <strong style={{ fontSize: '0.85rem' }}>Candidate Solver Evaluations (Multi-Criteria):</strong>
                                    <table style={{ width: '100%', marginTop: '0.4rem', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                                      <thead>
                                        <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)', color: 'var(--color-muted)' }}>
                                          <th style={{ padding: '0.3rem' }}>Engine</th>
                                          <th style={{ padding: '0.3rem' }}>Admissible</th>
                                          <th style={{ padding: '0.3rem' }}>Predicted Latency</th>
                                          <th style={{ padding: '0.3rem' }}>Predicted Quality</th>
                                          <th style={{ padding: '0.3rem' }}>Failure Risk</th>
                                          <th style={{ padding: '0.3rem' }}>Utility Score</th>
                                          <th style={{ padding: '0.3rem' }}>Rejection Reason</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {obs.candidateEvaluations.map((cand, cIdx) => (
                                          <tr key={cIdx} style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                                            <td style={{ padding: '0.3rem', fontWeight: 600 }}>{cand.engine}</td>
                                            <td style={{ padding: '0.3rem' }}>
                                              <Badge variant={cand.admissible ? 'success' : 'error'}>
                                                {cand.admissible ? 'YES' : 'REJECTED'}
                                              </Badge>
                                            </td>
                                            <td style={{ padding: '0.3rem' }}>
                                              {cand.predicted?.latency != null ? `${Number(cand.predicted.latency).toFixed(2)}s` : '—'}
                                            </td>
                                            <td style={{ padding: '0.3rem' }}>
                                              {cand.predicted?.quality != null ? Number(cand.predicted.quality).toFixed(2) : '—'}
                                            </td>
                                            <td style={{ padding: '0.3rem' }}>
                                              {cand.predicted?.failureRisk != null ? `${(Number(cand.predicted.failureRisk) * 100).toFixed(1)}%` : '—'}
                                            </td>
                                            <td style={{ padding: '0.3rem', fontWeight: 'bold' }}>
                                              {cand.utility != null ? Number(cand.utility).toFixed(3) : '—'}
                                            </td>
                                            <td style={{ padding: '0.3rem', color: 'var(--color-error)' }}>
                                              {cand.rejectionReason || '—'}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
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

            {/* Pagination */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-muted)' }}>
                Showing {obsOffset + 1}–{Math.min(obsOffset + PAGE_SIZE, totalObs)} of {totalObs} observations
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={obsOffset === 0}
                  onClick={() => setObsOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={obsOffset + PAGE_SIZE >= totalObs}
                  onClick={() => setObsOffset((prev) => prev + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
