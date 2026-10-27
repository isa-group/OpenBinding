import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { jobsApi } from '../../api/jobs';
import { platformApi, type Job, type StudyCell as StudyCellView } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { CopyField } from '../../components/ui/CopyField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { SourceView } from '../../components/rendering/SourceView';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { normalizeStatus, shortJobId } from '../Jobs/jobsModel';
import { RefusalNotice } from '../Jobs/parts';
import { Choice } from '../Organization/parts';
import { StateChip, StudyFrame, StudyGate } from './parts';
import { loadRun } from './runData';
import { StudyScope, type StudyScopeValue } from './StudyScope';
import {
  RUNTIME, describeParameters, engineKeyOf, engineTitle, enginesOf, explainFailure, formatMeasure, formatSeconds, isActiveState, isRetryable, measureLabel,
  measureValue, measuresOf, metricsOf, revisionLabel, rivalsOf, seedsOf,
} from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';
import { POLL_MS, usePolling } from './usePolling';
import { useRevisionIndex } from './useRevisionIndex';

const TABS = [{ id: 'result', label: 'Result' }, { id: 'source', label: 'Source' }];

type Outcome =
  | { tone: 'success'; text: string }
  | { tone: 'error'; refusal: Refusal };

const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);

/** The finished jobs of the account in this project, newest first: the ones whose result can stand in for a cell's. */
async function loadAttachable(org: string, project: string): Promise<{ jobs: Job[]; narrowed: boolean }> {
  const [rows, mine] = await Promise.all([platformApi.projectJobs(org, project), jobsApi.mine().then((own) => new Set(own.map((job) => job.id)), () => null)]);
  const finished = rows.filter((job) => TERMINAL_JOB.has(normalizeStatus(job.status)) && (mine === null || mine.has(job.id)));
  return { jobs: finished.sort((a, b) => b.created_at.localeCompare(a.created_at)), narrowed: mine !== null };
}

function AttachDialog({ scope, runId, cell, onClose, onAttached }: { scope: StudyScopeValue; runId: string; cell: StudyCellView; onClose: () => void; onAttached: () => void }) {
  const { organization, project, study } = scope;
  const jobs = useResource(`attachable:${organization.slug}/${project.slug}`, () => loadAttachable(organization.slug, project.slug));
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const list = jobs.data?.jobs ?? [];
  const attach = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await platformApi.attachStudyCellResult(organization.slug, project.slug, study.slug, runId, cell.id, chosen);
      onAttached();
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'attach'));
      setBusy(false);
    }
  };
  return (
    <Modal title="Use an existing job’s result" size="lg" onClose={() => !busy && onClose()}>
      <p>A job you already ran becomes this cell’s result as it is. It has to be a run of this cell: the same case revision, engine, mode and seed. The gateway checks, and names what differs if it isn’t.</p>
      {jobs.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Loading your jobs…</span><Skeleton variant="tile" /></div>}
      {jobs.status === 'error' && <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={jobs.reload}>Retry</Action>}>Your jobs couldn’t be loaded{marker(classifyAuthError(jobs.error))}.</Notice>}
      {jobs.status === 'ready' && list.length === 0 && <p className="org-muted">You have no finished job in this project to attach.</p>}
      {list.length > 0 && (
        <div className="st-choices" role="radiogroup" aria-label="Finished jobs">
          {list.map((job) => (
            <Choice
              key={job.id}
              name="attach-job"
              value={job.id}
              checked={chosen === job.id}
              onChange={setChosen}
              label={`${job.engine_id} · ${normalizeStatus(job.status)}`}
              sub={`${shortJobId(job.id)} · ${formatDateTime(job.created_at) ?? 'unknown date'}${job.termination ? ` · ${job.termination.toLowerCase()}` : ''}`}
            />
          ))}
        </div>
      )}
      {refusal && <RefusalNotice refusal={refusal} />}
      <div className="ui-modal-actions">
        <Action variant="secondary" onClick={onClose} disabled={busy}>Cancel</Action>
        <Action variant="primary" busy={busy} disabled={!chosen} onClick={() => void attach()}>Attach this result</Action>
      </div>
    </Modal>
  );
}

function RivalsCard({ cell, cells, measure, onMeasure, measures, runPath }: {
  cell: StudyCellView; cells: readonly StudyCellView[]; measure: string; onMeasure: (name: string) => void; measures: string[]; runPath: string;
}) {
  const rivals = rivalsOf(cell, cells);
  const labels = new Map(enginesOf(rivals).map((engine) => [engine.key, engine.label]));
  const values = rivals.map((item) => measureValue(item, measure)).filter((value): value is number => value !== null);
  const top = values.length ? Math.max(...values) : 0;
  const best = values.length ? Math.min(...values) : null;
  const seeds = seedsOf(cell, cells);
  return (
    <section className="st-card" aria-labelledby="st-rivals-title">
      <div className="st-card-head">
        <h2 id="st-rivals-title">Against the other engines</h2>
        {measures.length > 1 && (
          <label className="job-select">
            <span>Compare by</span>
            <select aria-label="Compare by" value={measure} onChange={(event) => onMeasure(event.target.value)}>
              {measures.map((name) => <option key={name} value={name}>{measureLabel(name)}</option>)}
            </select>
          </label>
        )}
      </div>
      {rivals.length < 2 ? (
        <p className="org-muted">No other engine ran this case with the same setting and seed in this run.</p>
      ) : (
        <ul className="st-rivals" aria-label={`${measureLabel(measure)} of each engine on this input`}>
          {rivals.map((item) => {
            const value = measureValue(item, measure);
            const isThis = item.id === cell.id;
            return (
              <li key={item.id} className={isThis ? 'is-this' : undefined}>
                <span className="st-rival-name">
                  {isThis ? <b>{labels.get(engineKeyOf(item.engine_ref)) ?? engineTitle(item.engine_ref)} (this cell)</b> : <Link to={`${runPath}/cells/${item.id}`} viewTransition>{labels.get(engineKeyOf(item.engine_ref)) ?? engineTitle(item.engine_ref)}</Link>}
                </span>
                <span className="st-rival-bar" aria-hidden="true"><i className={value !== null && best !== null && value === best ? 'is-best' : undefined} style={{ width: `${value !== null && top > 0 ? Math.max(3, Math.round((value / top) * 100)) : 0}%` }} /></span>
                <span className="st-rival-value">{value !== null ? formatMeasure(value) : <StateChip state={item.state} />}{value !== null && best !== null && value === best && rivals.length > 1 ? <small> best</small> : null}</span>
              </li>
            );
          })}
        </ul>
      )}
      {seeds.length > 1 && (
        <p className="st-caption">
          Same engine, other seeds: {seeds.map((item) => {
            const value = measureValue(item, measure);
            return `seed ${item.seed} ${value !== null ? formatMeasure(value) : item.state}`;
          }).join(' · ')}.
        </p>
      )}
    </section>
  );
}

function CellBody({ scope, runId, cellId }: { scope: StudyScopeValue; runId: string; cellId: string }) {
  const { study, organization, project, access, root } = scope;
  const org = organization.slug;
  const slug = project.slug;
  const navigate = useNavigate();
  const studyPath = `${root}/studies/${encodeURIComponent(study.slug)}`;
  const runPath = `${studyPath}/runs/${runId}`;
  const { index } = useRevisionIndex(org, slug);
  const siblings = useResource(`cell-run:${study.id}/${runId}`, () => loadRun(org, slug, study.slug, runId));
  const one = useResource(`cell:${runId}/${cellId}`, () => platformApi.studyCell(org, slug, study.slug, runId, cellId));
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [tab, setTab] = useState<'result' | 'source'>('result');

  const cell = one.data ?? one.stale;
  const all = siblings.data ?? siblings.stale;
  const reloadAll = () => { one.reload(); siblings.reload(); };
  usePolling(Boolean(cell && isActiveState(cell.state)), reloadAll, POLL_MS);
  const trail = (last: string) => [{ label: 'Studies', to: `${root}/studies` }, { label: study.name, to: studyPath }, { label: `Run #${all?.run.run_number ?? '…'}`, to: runPath }, { label: last }];

  if (one.status === 'error' && !cell) {
    const problem = classifyAuthError(one.error);
    return (
      <StudyFrame organization={organization} project={project} trail={trail('Cell')} width={problem.status === 404 ? 'lg' : 'wide'}>
        {problem.status === 404 ? (
          <StudyGate title="Cell not found" action={<Action to={studyPath} variant="primary">Back to the study</Action>}>
            No such cell here (404). It may belong to another run, or the run no longer exists.
          </StudyGate>
        ) : problem.status === 403 ? (
          <Notice tone="warning" title={`This API key can’t show this cell${marker(problem)}`}>The key isn’t allowed to use the engine this cell pins.</Notice>
        ) : (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={one.reload}>Retry</Action>}>The cell couldn’t be loaded{marker(problem)}.</Notice>
        )}
      </StudyFrame>
    );
  }
  if (!cell) {
    return (
      <StudyFrame organization={organization} project={project} trail={trail('Cell')}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the cell…</span><Skeleton variant="panel" /></div>
      </StudyFrame>
    );
  }

  const cells = all?.cells ?? [];
  const metrics = metricsOf(cell);
  const measures = measuresOf(cells.length ? cells : [cell]);
  const measure = measureChoice && measures.includes(measureChoice) ? measureChoice : measures[0] ?? RUNTIME;
  const info = index.get(cell.binding_case_revision_id);
  const failure = cell.state === 'failed' ? explainFailure(metrics) : null;
  const ref = cell.engine_ref;

  const retry = async () => {
    setRetrying(true);
    setOutcome(null);
    try {
      await platformApi.retryStudyCell(org, slug, study.slug, runId, cell.id);
      setOutcome({ tone: 'success', text: 'Cell queued again.' });
      reloadAll();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'retry') });
    } finally {
      setRetrying(false);
    }
  };

  const inputs: Array<[string, ReactNode]> = [
    ['Case', info ? <Link to={`${root}/cases/${encodeURIComponent(info.caseSlug)}/revisions/${info.revision}`} viewTransition>{revisionLabel(index, cell.binding_case_revision_id)}</Link> : revisionLabel(index, cell.binding_case_revision_id)],
    ['Engine', engineTitle(ref)],
    ['Mode', ref.mode ?? '—'],
    ['Settings', describeParameters(cell.parameters)],
    ['Seed', String(cell.seed)],
    ['Snapshot', info?.snapshotId ? <Link to={`${root}/snapshots/${info.snapshotId}`} viewTransition>{info.snapshotId.slice(0, 8)}…</Link> : '—'],
  ];

  return (
    <StudyFrame organization={organization} project={project} trail={trail(`Cell ${cell.ordinal}`)}>
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>Cell {cell.ordinal}</h1>
            <StateChip state={cell.state} />
          </div>
          {cells.length > 1 && (
            <label className="job-select">
              <span>Other cell</span>
              <select aria-label="Other cell" value={cell.id} onChange={(event) => void navigate(`${runPath}/cells/${event.target.value}`, { viewTransition: true })}>
                {cells.map((item) => (
                  <option key={item.id} value={item.id}>
                    Cell {item.ordinal} · {revisionLabel(index, item.binding_case_revision_id, true)} · {item.engine_ref.name ?? 'engine'} · seed {item.seed} · {item.state}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {access.canCreate && (
          <div className="proj-actions">
            {isRetryable(cell.state) && <Action variant="primary" busy={retrying} onClick={() => void retry()}>Retry this cell</Action>}
            <Action variant="secondary" disabled={retrying} onClick={() => setAttaching(true)}>Use an existing job’s result</Action>
          </div>
        )}
      </header>

      {outcome?.tone === 'success' && <Notice tone="success">{outcome.text}</Notice>}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
      {!access.canCreate && <p className="org-muted">Read-only: retrying and attaching a result need MEMBER in {organization.name}.</p>}

      <TabBar items={TABS} value={tab} onChange={(id) => setTab(id as 'result' | 'source')} ariaLabel="Cell views" prefix="st-cell-view" />
      <TabPanel prefix="st-cell-view" active={tab}>
      {tab === 'source' ? (
        // [impl->req~frontend-studies-source-tab~1]
        <SourceView
          source={{ state: cell.state, job_id: cell.job_id, engine: cell.engine_ref, parameters: cell.parameters, seed: cell.seed, metrics: cell.metrics }}
          label="Cell metrics source"
          filename={`${cell.id}.cell.json`}
        />
      ) : (
      <>
      <section className="st-card" aria-labelledby="st-inputs-title">
        <h2 id="st-inputs-title">Frozen inputs</h2>
        <div className="job-facts-grid">
          {inputs.map(([label, value]) => (
            <div key={label} className="job-fact"><div>{label}</div><div>{value}</div></div>
          ))}
        </div>
        <div className="st-fingerprint">
          <span>Fingerprint</span>
          <CopyField value={cell.fingerprint} label="cell fingerprint" truncate />
        </div>
        <span className="st-caption">These never change between runs: the same cell in the next run has the same fingerprint.</span>
      </section>

      {cell.state === 'completed' && (
        <section aria-labelledby="st-result-title" className="st-result">
          <h2 id="st-result-title" className="sr-only">Result</h2>
          <ul className="job-figures">
            <li><span>Outcome</span><b>{metrics.feasible === false ? 'Infeasible' : 'Feasible'}</b><small>{metrics.termination ? metrics.termination.toLowerCase() : 'meets every must-hold rule'}</small></li>
            {Object.entries(metrics.objectives).map(([name, value]) => <li key={name}><span>{measureLabel(name)}</span><b>{formatMeasure(value)}</b><small>objective · lower is better</small></li>)}
            <li><span>Took</span><b>{formatSeconds(metrics.runtimeSeconds)}</b><small>from queued to finished</small></li>
          </ul>
        </section>
      )}
      {cell.state === 'failed' && failure && (
        <Notice tone="error" title={`Failed: ${failure.title}`}>
          {metrics.code ? `Code ${metrics.code}${failure.detail ? ` · ${failure.detail}` : ''}. ` : ''}Retrying usually helps.
        </Notice>
      )}
      {cell.state === 'cancelled' && <Notice tone="info">Cancelled before it ran. Retry it, or attach the result of a job you already ran with the same inputs.</Notice>}
      {isActiveState(cell.state) && <Notice tone="info">{cell.state === 'queued' ? 'Waiting for a job slot.' : 'The engine is solving it.'} This page updates by itself.</Notice>}

      {cell.state === 'completed' && <RivalsCard cell={cell} cells={cells} measure={measure} onMeasure={setMeasureChoice} measures={measures} runPath={runPath} />}

      <p className="st-job-line">
        <span className="org-muted">Linked job:</span>{' '}
        {cell.job_id
          ? <Link to={`${root}/jobs/${cell.job_id}`} viewTransition title="A job opens for whoever launched it">{shortJobId(cell.job_id)}</Link>
          : <span>none yet</span>}
        {' · '}<Link to={`${runPath}/analytics`} viewTransition>Compare results</Link>
        {' · '}<Link to={runPath} viewTransition>Back to the run</Link>
      </p>
      </>
      )}
      </TabPanel>

      {attaching && (
        <AttachDialog
          scope={scope}
          runId={runId}
          cell={cell}
          onClose={() => setAttaching(false)}
          onAttached={() => { setAttaching(false); setOutcome({ tone: 'success', text: 'Result attached. It now counts as this cell’s result.' }); reloadAll(); }}
        />
      )}
    </StudyFrame>
  );
}

/** One cell of a run (`study-cell`, `/app/:org/:project/studies/:study/runs/:run/cells/:cell`): what it ran on, how it ended, and how the engines compare on it. */
export function StudyCell() {
  const { run = '', cell = '' } = useParams();
  return <StudyScope>{(scope) => <CellBody key={`${scope.study.id}/${run}/${cell}`} scope={scope} runId={run} cellId={cell} />}</StudyScope>;
}
