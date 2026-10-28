import { Link } from 'react-router-dom';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { ArtifactVersionPicker } from '../../components/Artifacts/ArtifactVersionPicker';
import { Action } from '../../components/ui/Action';
import { RunResult } from '../../components/rendering/RunResult';
import { Notice } from '../../components/ui/Notice';
import { useRunProblem } from '../Jobs/useRunProblem';
import { executionKey } from './bimDocuments';
import { RANGE_REFUSAL } from '../../utils/featureRange';
import { refusesRanges } from './workbenchModel';
import type { Workbench } from './useWorkbench';

/** Solve the package with an engine: which mode, and the evaluated answer. */
// [impl->req~frontend-rendering-workbench-run-result~1]
// [impl->req~frontend-rendering-run-result-allow-list~1]
export function RunPanel({ wb, orgSlug, jobsHref }: { wb: Workbench; orgSlug: string; jobsHref: string }) {
  const loaded = useRunProblem(wb.resultJobId, Boolean(wb.result));
  // A run with no job id has no compiled problem to wait for.
  const problem = wb.resultJobId ? loaded.problem : null;
  const constraints = wb.resultJobId ? loaded.constraints : [];
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
            </div>
            <RunResult result={wb.result} problem={problem} constraints={constraints} />
          </section>
        </>
      )}
    </section>
  );
}
