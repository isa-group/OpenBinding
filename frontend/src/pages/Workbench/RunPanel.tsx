import { Link } from 'react-router-dom';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { executionKey, isRecord, type BindingDecision, type BindingSolution } from './bimDocuments';
import { RANGE_REFUSAL } from '../../utils/featureRange';
import { refusesRanges } from './workbenchModel';
import type { Workbench } from './useWorkbench';

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

/** Solve the package with an engine: which mode, and the evaluated answer. */
export function RunPanel({ wb, orgSlug, jobsHref }: { wb: Workbench; orgSlug: string; jobsHref: string }) {
  const working = wb.runState === 'queued' || wb.runState === 'running';
  // A package with ranges can only go to a mode that declares interval values: the others stay in the list, off, with the reason.
  const refused = wb.hasRanges ? wb.allModes.filter(refusesRanges) : [];
  const catalog = wb.resources.find((resource) => resource.kind === 'CandidateCatalog' && resource.path);
  const editCandidates = () => {
    if (!catalog?.path) return;
    wb.selectResource(catalog.path, catalog.kind);
    document.getElementById('wb-editor')?.scrollIntoView?.({ block: 'start' });
  };
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
            disabled={(!wb.compatibleModes.length && !refused.length) || Boolean(wb.executionConfiguration)}
          >
            <option value="">Validate to select…</option>
            {wb.compatibleModes.map((item) => {
              const value = executionKey(item);
              return <option key={value} value={value}>{item.engine.name} · {item.mode} · {item.registration.name}@{item.registration.version}</option>;
            })}
            {refused.map((item) => {
              const value = executionKey(item);
              return <option key={value} value={value} disabled>{item.engine.name} · {item.mode} · {item.registration.name}@{item.registration.version} — can’t run ranges</option>;
            })}
          </select>
        </label>
      </div>
      {refused.length > 0 && (
        <p className="wb-muted wb-range-note" role="note">
          {refused.length === 1 ? '1 engine mode is' : `${refused.length} engine modes are`} off. {RANGE_REFUSAL}.{' '}
          <Link to="/engines" viewTransition>Engines</Link>
          {catalog?.path && <> · <button type="button" className="wb-link" onClick={editCandidates}>Edit the candidates</button></>}
        </p>
      )}

      {working && (
        <div className="wb-compiling" role="status">
          <span className="wb-compiling-title"><span className="wb-spinner" aria-hidden="true" />{wb.runState === 'queued' ? 'Queued: the engine has not started yet…' : 'Running: the engine is searching…'}</span>
          <div className="wb-progress" aria-hidden="true"><i /></div>
        </div>
      )}
      {wb.runError && (
        <Notice tone="error" title={wb.runRange ? 'This engine only accepts single values' : 'The run did not finish'} action={<Link to={jobsHref} viewTransition>See jobs</Link>}>
          {wb.runError}
          {wb.runRange && (
            <span className="wb-range-note">
              {' '}<Link className="ui-notice-link" to="/engines" viewTransition>Engines</Link>
              {catalog?.path && <> · <button type="button" className="wb-link" onClick={editCandidates}>Edit the candidates</button></>}
            </span>
          )}
        </Notice>
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
