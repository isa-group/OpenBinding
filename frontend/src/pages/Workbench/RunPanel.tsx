import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { executionKey, isRecord, type BindingDecision, type BindingSolution } from './bimDocuments';
import type { AutoProfile, Workbench } from './useWorkbench';

function DecisionView({ decision }: { decision: BindingDecision | undefined }) {
  if (decision?.kind === 'binding' && decision.binding && typeof decision.binding === 'object') {
    return (
      <table className="wb-decision-table">
        <thead><tr><th scope="col">Task</th><th scope="col">Candidate resource</th><th scope="col">Candidate</th></tr></thead>
        <tbody>
          {Object.entries(decision.binding).map(([task, candidate]) => (
            <tr key={task}><td>{task}</td><td>{candidate?.resource}</td><td>{candidate?.id}</td></tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <details className="wb-details">
      <summary>View source</summary>
      <pre>{JSON.stringify(decision, null, 2)}</pre>
    </details>
  );
}

function Metrics({ value }: { value: unknown }) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  if (entries.length === 0) return null;
  return (
    <ul className="wb-metrics" aria-label="Quality of this binding">
      {entries.map(([name, amount]) => <li key={name}><span>{name}</span><b>{amount}</b></li>)}
    </ul>
  );
}

function Solution({ solution, index }: { solution: BindingSolution; index: number }) {
  return (
    <section className="wb-decision" aria-label={`Solution ${index + 1}`}>
      <div className="wb-decision-head">
        <Chip tone="accent">{solution.decision?.kind || 'unknown'}</Chip>
        <Metrics value={solution.metrics} />
      </div>
      <DecisionView decision={solution.decision} />
      <details className="wb-details">
        <summary>View source · evaluation, penalties and violations</summary>
        <pre>{JSON.stringify({ metrics: solution.metrics, objectives: solution.objectives, penalties: solution.penalties, violations: solution.violations, evaluation: solution.evaluation }, null, 2)}</pre>
      </details>
    </section>
  );
}

/** Solve the package with an engine: which mode, how the AutoRouter may decide, and the evaluated answer. */
export function RunPanel({ wb, orgSlug, jobsHref }: { wb: Workbench; orgSlug: string; jobsHref: string }) {
  const working = wb.runState === 'queued' || wb.runState === 'running';
  const auto = wb.selectedMode === 'auto';
  const routing = wb.routingProvenance;
  return (
    <section className="wb-card" id="wb-run" aria-labelledby="wb-run-title">
      <div className="wb-card-head">
        <div>
          <h2 id="wb-run-title">Run with an engine</h2>
          <p className="wb-muted">The package is snapshotted, its compiled form goes to the engine you pick, and the gateway re-evaluates what comes back.</p>
        </div>
        <Action variant="primary" busy={working} disabled={wb.status === 'validating'} onClick={() => void wb.run()}>Solve</Action>
      </div>

      <div className="wb-run-controls">
        {orgSlug && (
          <fieldset className="wb-fieldset">
            <legend>Execution configuration (optional)</legend>
            <ArtifactVersionPicker org={orgSlug} kind="ExecutionConfiguration" versionId={wb.executionConfiguration?.id} onSelect={(_, version) => wb.setExecutionConfiguration(version)} />
            {wb.executionConfiguration && (
              <p className="wb-config-note">
                Using sealed configuration {wb.executionConfiguration.ref.name}@{wb.executionConfiguration.ref.version}.{' '}
                <button type="button" className="wb-link" onClick={() => wb.setExecutionConfiguration(null)}>Use engine selection instead</button>
              </p>
            )}
          </fieldset>
        )}
        <label className="wb-field">
          <span>Compatible engine mode</span>
          <select
            aria-label="Compatible engine mode"
            value={wb.selectedMode}
            onChange={(event) => wb.setSelectedMode(event.target.value)}
            disabled={(!wb.compatibleModes.length && !auto) || Boolean(wb.executionConfiguration)}
          >
            <option value="">Validate to select…</option>
            <option value="auto">AutoRouter (self-adaptive, MAPE-K)</option>
            {wb.compatibleModes.map((item) => {
              const value = executionKey(item);
              return <option key={value} value={value}>{item.engine.name} · {item.mode} · {item.registration.name}@{item.registration.version}</option>;
            })}
          </select>
        </label>
      </div>

      {auto && (
        <fieldset className="wb-fieldset wb-auto">
          <legend><Compass aria-hidden="true" />AutoRouter policy</legend>
          <div className="wb-auto-grid">
            <label className="wb-field">
              <span>Optimization profile</span>
              <select value={wb.autoProfile} onChange={(event) => wb.setAutoProfile(event.target.value as AutoProfile)}>
                <option value="balanced">Balanced</option>
                <option value="quality_first">Quality first</option>
                <option value="latency_first">Latency first</option>
                <option value="cost_first">Cost first</option>
              </select>
            </label>
            <label className="wb-field">
              <span>Max credits: {wb.autoMaxCredits} CU</span>
              <input type="number" min={1} max={100} value={wb.autoMaxCredits} onChange={(event) => wb.setAutoMaxCredits(parseInt(event.target.value, 10) || 40)} />
            </label>
            <label className="wb-field">
              <span>Min quality: {wb.autoMinQuality.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={wb.autoMinQuality} onChange={(event) => wb.setAutoMinQuality(parseFloat(event.target.value))} />
            </label>
            <label className="wb-field">
              <span>Max failure risk: {wb.autoMaxFailureRisk.toFixed(2)}</span>
              <input type="range" min={0} max={1} step={0.05} value={wb.autoMaxFailureRisk} onChange={(event) => wb.setAutoMaxFailureRisk(parseFloat(event.target.value))} />
            </label>
            <div className="wb-checks">
              <label><input type="checkbox" checked={wb.autoRequireExact} onChange={(event) => wb.setAutoRequireExact(event.target.checked)} /> Require an exact solver</label>
              <label><input type="checkbox" checked={wb.autoAllowFallback} onChange={(event) => wb.setAutoAllowFallback(event.target.checked)} /> Allow a fallback solver</label>
            </div>
          </div>
        </fieldset>
      )}

      {working && (
        <div className="wb-compiling" role="status">
          <span className="wb-compiling-title"><span className="wb-spinner" aria-hidden="true" />{wb.runState === 'queued' ? 'Queued: the engine has not started yet…' : 'Running: the engine is searching…'}</span>
          <div className="wb-progress" aria-hidden="true"><i /></div>
        </div>
      )}
      {wb.runError && (
        <Notice tone="error" title="The run did not finish" action={<Link to={jobsHref} viewTransition>See jobs</Link>}>{wb.runError}</Notice>
      )}

      {routing && (
        <section className="wb-routing" aria-label="AutoRouter decision">
          <div className="wb-routing-head">
            <Compass aria-hidden="true" />
            <strong>AutoRouter decision</strong>
            <Chip tone="accent">{routing.selectedEngine} · {routing.selectedMode}</Chip>
            {routing.fallbackActivated && <Chip tone="warning">Fallback activated</Chip>}
            <span className="wb-muted">Utility {routing.utilityScore != null ? routing.utilityScore.toFixed(3) : 'n/a'} · Credits {routing.creditsCost ?? 1} CU</span>
          </div>
          <p className="wb-muted">{routing.adaptationReason}</p>
        </section>
      )}

      {wb.result && (
        <>
          <BindingAnalysis result={wb.result} jobId={wb.resultJobId} />
          <section className="wb-result" aria-label="Authoritative result">
            <div className="wb-pane-head">
              <div><span className="wb-eyebrow">Gateway-reevaluated output</span><h3>Authoritative result</h3></div>
              <p className="wb-result-summary">{wb.result.solutions?.length || 0} solution(s) · <strong>{wb.result.termination || 'UNKNOWN'}</strong></p>
            </div>
            {wb.result.solutions?.map((solution, index) => <Solution solution={solution} index={index} key={index} />)}
          </section>
        </>
      )}
    </section>
  );
}
