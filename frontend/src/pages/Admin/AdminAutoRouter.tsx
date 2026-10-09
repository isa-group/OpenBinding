import { Fragment, useState } from 'react';
import { Compass, RefreshCw } from 'lucide-react';
import { apiClient, type AdaptationObservationItem, type EngineRoutingMetricSnapshot } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ConfirmDialog } from '../Engines/EngineDialogs';
import { AdminFrame, FailureNotice, Meter, Pager, Tag } from './AdminChrome';
import { count, describeAdminFailure, type Failure } from './adminModel';

const PAGE_SIZE = 15;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fixed = (value: unknown, digits: number, fallback = '—', suffix = '') => (isNumber(value) ? `${value.toFixed(digits)}${suffix}` : fallback);
const percent = (value: unknown) => (isNumber(value) ? `${(value * 100).toFixed(1)}%` : '—');
const signed = (value: unknown, digits: number, suffix = '') => (isNumber(value) ? `${value > 0 ? '+' : ''}${value.toFixed(digits)}${suffix}` : '—');

/** How long an observed run took, in seconds, when the gateway recorded it. */
function runTimeOf(observation: AdaptationObservationItem): number | null {
  const actual = observation.actualMetrics;
  const value = actual?.actualLatency ?? actual?.latency;
  return isNumber(value) ? value : null;
}

function confidenceTone(confidence: number): 'success' | 'warning' | 'error' {
  return confidence > 0.7 ? 'success' : confidence > 0.4 ? 'warning' : 'error';
}

function EngineCard({ id, snapshot, runs, scale }: { id: string; snapshot: EngineRoutingMetricSnapshot; runs: Array<{ seconds: number; failed: boolean }>; scale: number }) {
  const confidence = isNumber(snapshot.confidence) ? snapshot.confidence : 0.5;
  const healthy = snapshot.healthStatus === 'HEALTHY';
  const failures = runs.filter((run) => run.failed).length;
  return (
    <li className="adm-engine" aria-label={id}>
      <div className="adm-engine-head">
        <strong className="is-mono">{id}</strong>
        <Tag tone={healthy ? 'success' : 'error'}>{snapshot.healthStatus || 'UNKNOWN'}</Tag>
      </div>
      <div className="adm-engine-meta">
        <span>{snapshot.available ? 'Online' : 'Offline'}</span>
        <span>{snapshot.activeJobs ?? 0} active job{snapshot.activeJobs === 1 ? '' : 's'}</span>
      </div>
      <div className="adm-engine-confidence">
        <span className="adm-label">Confidence</span>
        <Meter value={confidence * 100} tone={confidenceTone(confidence)} />
        <strong>{Math.round(confidence * 100)}%</strong>
      </div>
      <dl className="adm-engine-stats">
        <div><dt>Failures, last hour</dt><dd>{isNumber(snapshot.oneHourFailureRate) ? percent(snapshot.oneHourFailureRate) : '0.0%'}</dd></div>
        <div><dt>Average latency</dt><dd>{fixed(snapshot.avgLatency, 2, 'N/A', ' s')}</dd></div>
        <div><dt>Drift (CUSUM)</dt><dd>{snapshot.driftAlarm ? <Tag tone="warning">Drift alarm</Tag> : `Stable · S⁺ ${fixed(snapshot.cusumSPlus, 2, '0.00')}`}</dd></div>
      </dl>
      <div className="adm-dots" aria-hidden="true">
        {runs.map((run, index) => (
          <span key={index} className={run.failed ? 'is-failed' : undefined} style={{ left: `${Math.min(100, (run.seconds / scale) * 100)}%` }} />
        ))}
      </div>
      <span className="adm-dots-axis" aria-hidden="true"><span>0 s</span><span>run time</span><span>{Math.round(scale)} s</span></span>
      <span className="sr-only">
        {runs.length === 0 ? `${id}: no run times in the observations shown.` : `${id}: ${runs.length} run time${runs.length === 1 ? '' : 's'} in the observations shown, ${failures} failed.`}
      </span>
    </li>
  );
}

function Candidates({ observation }: { observation: AdaptationObservationItem }) {
  if (observation.candidateEvaluations.length === 0) return <p className="adm-muted">No candidate evaluations were recorded.</p>;
  return (
    <DataTable label="Candidate solver evaluations" minWidth={640}>
      <thead>
        <tr>
          <th scope="col">Engine</th>
          <th scope="col">Admissible</th>
          <th scope="col">Predicted latency</th>
          <th scope="col">Predicted quality</th>
          <th scope="col">Failure risk</th>
          <th scope="col">Utility</th>
          <th scope="col">Rejection reason</th>
        </tr>
      </thead>
      <tbody>
        {observation.candidateEvaluations.map((candidate, index) => (
          <tr key={`${candidate.engine}-${index}`}>
            <td className="is-mono">{candidate.engine}</td>
            <td><Tag tone={candidate.admissible ? 'success' : 'error'}>{candidate.admissible ? 'Yes' : 'Rejected'}</Tag></td>
            <td>{fixed(candidate.predicted?.latency, 2, '—', ' s')}</td>
            <td>{fixed(candidate.predicted?.quality, 2)}</td>
            <td>{percent(candidate.predicted?.failureRisk)}</td>
            <td><strong>{fixed(candidate.utility, 3)}</strong></td>
            <td>{candidate.rejectionReason || '—'}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function withFallbackNote(failure: Failure): Failure {
  return failure.status === 401 || failure.status === 403 ? failure : { ...failure, text: `${failure.text} Engine suggestions keep working with the last calibration.` };
}

/**
 * admin-routing: how the AutoRouter is doing. Each engine’s health and drift as the router monitors them, the observations it learns from
 * (what it chose, what the run then did, how far the prediction was off), and the recalibration that refits it on everything observed.
 */
export function AdminAutoRouter() {
  const [engine, setEngine] = useState('');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recalibrated, setRecalibrated] = useState<{ status: string; at: string; processed: number; engines: string[] } | null>(null);
  const [recalibrateFailure, setRecalibrateFailure] = useState<Failure | null>(null);

  const metrics = useResource('admin-routing-metrics', () => apiClient.adminGetEngineRoutingMetrics());
  const observations = useResource(`admin-routing-observations:${engine}:${offset}`, () => apiClient.adminListEngineRoutingObservations({ engine: engine || undefined, limit: PAGE_SIZE, offset }));

  const snapshot = metrics.data ?? metrics.stale;
  const page = observations.data ?? observations.stale;
  const engines = Object.entries(snapshot?.engines ?? {});
  const rows = page?.observations ?? [];
  const metricsFailure = metrics.status === 'error' ? withFallbackNote(describeAdminFailure(metrics.error, 'Routing metrics couldn’t be loaded')) : null;
  const observationsFailure = observations.status === 'error' ? describeAdminFailure(observations.error, 'Observations couldn’t be loaded') : null;
  const refreshing = (metrics.status === 'loading' && Boolean(snapshot)) || (observations.status === 'loading' && Boolean(page));

  const refresh = () => { metrics.reload(); observations.reload(); };

  const runsOf = (id: string) => rows.filter((row) => row.engineSelected === id).flatMap((row) => {
    const seconds = runTimeOf(row);
    return seconds === null ? [] : [{ seconds, failed: row.outcome !== 'success' }];
  });
  const allRuns = rows.map(runTimeOf).filter(isNumber);
  const scale = Math.max(10, Math.ceil(Math.max(0, ...allRuns) / 10) * 10);

  const summary = snapshot?.summary;
  const healthy = summary?.healthyEngines ?? engines.filter(([, item]) => item.healthStatus === 'HEALTHY').length;
  const degraded = summary?.degradedEngines ?? engines.filter(([, item]) => item.healthStatus === 'DEGRADED').length;
  const total = page?.total ?? 0;
  const nothingObserved = Boolean(snapshot) && Boolean(page) && engines.length === 0 && total === 0 && engine === '';

  const recalibrate = async () => {
    setBusy(true);
    setRecalibrateFailure(null);
    try {
      const result = await apiClient.adminRecalibrateEngineRouting();
      setRecalibrated({ status: result.status, at: result.recalibratedAt, processed: result.observationsProcessed, engines: result.calibratedEngines });
      refresh();
    } catch (error: unknown) {
      setRecalibrated(null);
      setRecalibrateFailure(describeAdminFailure(error, 'Recalibration failed'));
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  const filters = [{ id: '', label: 'All' }, ...engines.map(([id]) => ({ id, label: id }))];

  return (
    <AdminFrame
      section="routing"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Engine routing' }]}
      title="Engine routing"
      lede="The router learns from finished runs how long each engine takes and how often it fails, and uses that to suggest engines. Recalibrating refits it on everything observed so far."
      actions={(
        <>
          <Action variant="secondary" onClick={refresh} busy={refreshing}><RefreshCw aria-hidden="true" />Refresh</Action>
          <Action variant="primary" onClick={() => setAsking(true)} disabled={busy}>Recalibrate…</Action>
        </>
      )}
    >
      {recalibrated && (
        <Notice tone="success" title="Recalibrated">
          The router was refitted. Recorded in the audit log.
        </Notice>
      )}
      {recalibrated && (
        <dl className="adm-tiles" aria-label="Recalibration result">
          <div><dt>Status</dt><dd className="is-text">{recalibrated.status}</dd></div>
          <div><dt>Observations processed</dt><dd>{count(recalibrated.processed)}</dd></div>
          <div><dt>Engines calibrated</dt><dd className="is-text">{recalibrated.engines.length > 0 ? recalibrated.engines.join(', ') : 'None'}</dd></div>
          <div><dt>Recalibrated at</dt><dd className="is-text">{formatDateTime(recalibrated.at) ?? recalibrated.at}</dd></div>
        </dl>
      )}
      {recalibrateFailure && <FailureNotice failure={recalibrateFailure} />}
      {metricsFailure && <FailureNotice failure={metricsFailure} onRetry={metrics.reload} />}
      {metrics.status === 'loading' && !snapshot && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading routing metrics</span><Skeleton variant="panel" /></div>}

      {nothingObserved && (
        <EmptyState icon={<Compass />} title="No observations yet" dashed>
          The router needs finished runs before it can calibrate. Launch a job with <code>engine: "auto"</code> to start its telemetry.
        </EmptyState>
      )}

      {snapshot && !nothingObserved && (
        <>
          <dl className="adm-tiles adm-tiles-wide" aria-label="Router health">
            <div><dt>Monitored engines</dt><dd>{count(summary?.totalEngines ?? engines.length)}</dd></div>
            <div><dt>Healthy</dt><dd>{count(healthy)}</dd></div>
            <div className={degraded > 0 ? 'is-attention' : undefined}><dt>Degraded</dt><dd>{count(degraded)}</dd></div>
            <div><dt>Running now</dt><dd>{count(summary?.activeJobs ?? 0)}</dd></div>
          </dl>

          {engines.length === 0
            ? <p className="adm-muted">No engine metrics reported yet.</p>
            : (
              <ul className="adm-engines" aria-label="Engines">
                {engines.map(([id, item]) => <EngineCard key={id} id={id} snapshot={item} runs={runsOf(id)} scale={scale} />)}
              </ul>
            )}
          <span className="adm-muted">Dots are run times of the observations shown below (red: the run didn’t succeed). The fit quality of the models isn’t reported by the API.</span>
        </>
      )}

      {(page || observations.status === 'loading' || observationsFailure) && !nothingObserved && (
        <section className="adm-card" aria-labelledby="adm-obs-title">
          <div className="adm-card-head">
            <h2 id="adm-obs-title">Observations</h2>
            {engines.length > 0 && <FilterPills ariaLabel="Engine" options={filters} value={engine} onChange={(id) => { setEngine(id); setOffset(0); setExpanded(null); }} />}
          </div>
          {observationsFailure && <FailureNotice failure={observationsFailure} onRetry={observations.reload} />}
          {observations.status === 'loading' && !page && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading observations</span><Skeleton variant="tile" /></div>}
          {page && rows.length === 0 && <p className="adm-muted">{engine ? `No observation selected ${engine}.` : 'No adaptation observations recorded yet.'}</p>}
          {rows.length > 0 && (
            <DataTable label="Observations" minWidth={760}>
              <thead>
                <tr>
                  <th scope="col">Recorded</th>
                  <th scope="col">Engine selected</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Workload</th>
                  <th scope="col">Residuals (Δ latency · Δ quality)</th>
                  <th scope="col"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const features = row.workloadFeatures ?? {};
                  const residuals = row.residuals ?? {};
                  const open = expanded === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr aria-label={`${row.engineSelected} ${row.id}`}>
                        <td>{row.createdAt ? formatDateTime(row.createdAt) ?? row.createdAt : 'N/A'}</td>
                        <td className="is-mono">{row.engineSelected}</td>
                        <td><Tag tone={row.outcome === 'success' ? 'success' : 'error'}>{row.outcome}</Tag></td>
                        <td className="is-mono">S {fixed(features.S, 1)} · D<sub>c</sub> {fixed(features.D_constr, 2)} · {fixed(features.N_tasks, 0)} tasks</td>
                        <td className="is-mono">{signed(residuals.latency, 2, ' s')} · {signed(residuals.quality, 2)}</td>
                        <td><Action size="sm" variant="link" aria-expanded={open} onClick={() => setExpanded(open ? null : row.id)}>{open ? 'Hide' : 'Inspect'}</Action></td>
                      </tr>
                      {open && (
                        <tr className="adm-expanded">
                          <td colSpan={6}>
                            <div className="adm-obs-detail">
                              <dl className="adm-detail">
                                <div><dt>Adaptation loop</dt><dd className="is-mono">{row.adaptationLoopId}</dd></div>
                                {row.jobId && <div><dt>Job</dt><dd className="is-mono">{row.jobId}</dd></div>}
                              </dl>
                              <Candidates observation={row} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          {page && rows.length > 0 && <Pager offset={offset} limit={PAGE_SIZE} total={total} shown={rows.length} noun="observations" onPage={(next) => { setOffset(next); setExpanded(null); }} />}
        </section>
      )}

      <section className="adm-card" aria-labelledby="adm-policy-title">
        <h2 id="adm-policy-title">How the router decides</h2>
        <p className="adm-muted">
          For each job started with <code>engine: "auto"</code> the router scores the candidate engines on predicted latency, quality and failure risk, drops the ones
          that can’t meet the job, and picks the best utility. After the run it records how far the prediction was off, and a CUSUM test raises a drift alarm when an engine
          keeps running slower or faster than expected. The weights and thresholds of that policy aren’t exposed by the API, so this screen shows what the router observed and
          chose, not how it is configured.
        </p>
      </section>

      {asking && (
        <ConfirmDialog
          title="Recalibrate the router?"
          confirmLabel="Recalibrate"
          busy={busy}
          onConfirm={() => void recalibrate()}
          onClose={() => setAsking(false)}
        >
          <p>
            It refits on all {engine === '' && page ? `${count(total)} ` : ''}observations. Engine suggestions may change for everyone as soon as it finishes. Recorded in the audit log.
          </p>
        </ConfirmDialog>
      )}
    </AdminFrame>
  );
}
