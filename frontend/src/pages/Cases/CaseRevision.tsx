import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { ProblemRevision as Revision } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { problemPath } from '../../routes/paths/problems';
import { formatBytes, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { formatFeature } from '../../utils/featureRange';
import type { BindingModel, FeatureValue, TaskInfo } from './bindingModel';
import { marker } from './caseErrors';
import { plural } from './casesModel';
import { loadModel, modelKey, type ModelState } from './modelLoader';
import { DigestLine, FlowDrawing, Power } from './parts';
import type { RouteProblemContent } from './useRouteProblem';

/** The finite ends of a value, which the bars of a column are drawn against. */
const finiteEnds = (value: FeatureValue | undefined): number[] => {
  if (value === undefined) return [];
  return (typeof value === 'number' ? [value] : [value.min, value.max]).filter((end): end is number => end !== null);
};

/** A value as a bar: how far a number reaches, or the stretch a range covers (an open end runs off the bar, faded, with an arrow). */
function FeatureBar({ value, maximum }: { value: FeatureValue; maximum: number }) {
  const at = (end: number) => (maximum ? Math.min(1, Math.abs(end) / maximum) : 0);
  if (typeof value === 'number') {
    return <span className="case-bar is-small" aria-hidden="true"><i style={{ width: `${Math.round(at(value) * 100)}%` }} /></span>;
  }
  const low = value.min === null ? 0 : at(value.min);
  const high = value.max === null ? 1 : at(value.max);
  const [from, to] = low <= high ? [low, high] : [high, low];
  const classes = [value.min === null ? 'is-open-low' : '', value.max === null ? 'is-open-high' : ''].filter(Boolean).join(' ');
  return (
    <span className="case-bar is-small is-interval" aria-hidden="true">
      <i className={classes || undefined} style={{ left: `${Math.round(from * 100)}%`, width: `${Math.round((to - from) * 100)}%` }} />
    </span>
  );
}

/** The candidates that can serve one task, one column per quality they declare. */
function CandidateTable({ model }: { model: BindingModel }) {
  const services = model.tasks.filter((task) => task.kind === 'service' && task.candidates.length > 0);
  const [picked, setPicked] = useState('');
  const task: TaskInfo | undefined = services.find((item) => item.id === picked) ?? services[0];
  if (!task) {
    return (
      <div className="proj-panel">
        <h3>Providers</h3>
        <p className="org-muted">No task of this version has candidates to list.</p>
      </div>
    );
  }
  const columns = [...new Set(task.candidates.flatMap((candidate) => Object.keys(candidate.features)))].slice(0, 5);
  const maxima = Object.fromEntries(columns.map((column) => [column, Math.max(...task.candidates.flatMap((candidate) => finiteEnds(candidate.features[column]).map(Math.abs)), 0)]));
  return (
    <section className="proj-panel case-candidates" aria-labelledby="rv-candidates">
      <div className="proj-panel-head">
        <h3 id="rv-candidates">Candidates</h3>
        <label className="case-sort">
          Task
          <select value={task.id} onChange={(event) => setPicked(event.target.value)}>
            {services.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
          </select>
        </label>
      </div>
      <span className="org-muted">{task.candidates.length === 1 ? '1 provider' : `${task.candidates.length} providers`} can serve <code>{task.id}</code>{task.capability ? ` (${task.capability})` : ''}.</span>
      <div className="case-table-scroll">
        <table className="case-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              {columns.map((column) => <th scope="col" key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {task.candidates.map((candidate) => (
              <tr key={candidate.id}>
                <th scope="row"><code>{candidate.name}</code>{candidate.provider && candidate.provider !== candidate.name && <small>{candidate.provider}</small>}</th>
                {columns.map((column) => {
                  const value = candidate.features[column];
                  const unit = model.features[column]?.unit ?? null;
                  return (
                    <td key={column}>
                      {value === undefined ? '—' : (
                        <span className="case-cell">
                          <FeatureBar value={value} maximum={maxima[column]} />
                          <span className={typeof value === 'number' ? undefined : 'case-range'} title={typeof value === 'number' ? undefined : formatFeature(value, { long: true, unit })}>
                            {formatFeature(value, { unit })}
                          </span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RulesCard({ model }: { model: BindingModel }) {
  return (
    <section className="proj-panel" aria-labelledby="rv-rules">
      <h3 id="rv-rules">Rules</h3>
      {model.rules.length === 0 && <p className="org-muted">This version declares no rules.</p>}
      <ul className="case-rules">
        {model.rules.map((rule) => (
          <li key={rule.id}>
            <span className={`case-must${rule.enforcement === 'soft' ? ' is-should' : ''}`}>{rule.enforcement === 'hard' ? 'MUST' : 'SHOULD'}</span>
            <span>
              {rule.text}
              {rule.when && <small> · when {rule.when}</small>}
              {rule.penalty && <small> · penalty {rule.penalty} if broken</small>}
              <small className="case-rule-id">{rule.id}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoalCard({ model }: { model: BindingModel }) {
  const heaviest = Math.max(...model.penalties.map((penalty) => penalty.weight), 0);
  return (
    <section className="proj-panel" aria-labelledby="rv-goal">
      <h3 id="rv-goal">Goal</h3>
      {model.criteria.length === 0 && <p className="org-muted">This version declares no criteria to optimize.</p>}
      <ul className="case-criteria">
        {model.criteria.map((criterion) => (
          <li key={criterion.id}>
            <span><b>{criterion.id}</b>{criterion.feature && criterion.feature !== criterion.id ? <small> ({criterion.feature})</small> : null}</span>
            <span>{criterion.direction === 'maximize' ? 'higher is better' : criterion.direction === 'minimize' ? 'lower is better' : 'direction not stated'}{criterion.range ? ` · scaled ${criterion.range.min}–${criterion.range.max}` : ''}</span>
          </li>
        ))}
      </ul>
      {model.penalties.length > 0 && (
        <>
          <b className="case-sub">Breaking a “should” rule costs</b>
          <ul className="case-criteria">
            {model.penalties.map((penalty) => (
              <li key={penalty.rule}>
                <span>{penalty.rule}</span>
                <span className="case-cell">
                  <span className="case-bar is-small" aria-hidden="true"><i style={{ width: `${heaviest ? Math.round((penalty.weight / heaviest) * 100) : 0}%` }} /></span>
                  weight {penalty.weight}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className="org-muted">How the criteria trade off against each other is chosen when the version is run, so no weights are shown here.</span>
    </section>
  );
}

function PlacementCard({ model }: { model: BindingModel }) {
  const { placement } = model;
  if (!placement) {
    return (
      <div className="case-dashed"><b>Placement</b> · not declared in this version (no pools, network or events).</div>
    );
  }
  return (
    <section className="proj-panel" aria-labelledby="rv-placement">
      <h3 id="rv-placement">Placement</h3>
      <ul className="case-criteria">
        {placement.pools.map((pool) => (
          <li key={pool.id}>
            <span><b>{pool.id}</b><small> ({pool.kind})</small></span>
            <span>{Object.entries(pool.capacity).map(([name, amount]) => `${name} ${amount.toLocaleString('en-US')}`).join(' · ') || 'no capacity stated'}</span>
          </li>
        ))}
      </ul>
      <span className="org-muted">
        {plural(placement.demands, 'demand')} · {plural(placement.links, 'network link')} · {plural(placement.events, 'event')} · {plural(placement.transitions, 'transition')}
      </span>
    </section>
  );
}

/** The Overview tab of the problem page: the model of the problem version on show, in plain language. */
export function VersionOverview({ organization, content, revision }: {
  organization: Organization; content: RouteProblemContent; revision: Revision;
}) {
  const { copy, status } = useCopy();
  const { item } = content;
  const org = organization.slug;
  const modelState = useResource<ModelState>(modelKey(org, item.slug, revision), () => loadModel(org, item.slug, revision.revision));

  const model = modelState.data?.state === 'ready' ? modelState.data.model : null;
  const compilation = modelState.data?.state === 'ready' ? modelState.data.compilation : null;
  const profile = model?.profile ?? null;

  return (
    <>

      <section aria-labelledby="rv-identity">
        <h2 id="rv-identity" className="sr-only">Identity</h2>
        <dl className="case-identity">
          <div><dt>Package fingerprint</dt><dd><DigestLine digest={revision.package_digest} label={`version ${revision.revision}`} copyKey="digest" /></dd></div>
          <div><dt>Sealed</dt><dd>{formatDateTime(revision.created_at) ?? '—'}</dd></div>
          <div>
            <dt>Language profile</dt>
            <dd>{profile ?? 'not stated'}{model && model.dialects.length === 0 ? ' · no dialects' : ''}</dd>
          </div>
          <div>
            <dt>Package</dt>
            <dd>
              {formatBytes(revision.package_size)?.split(' (')[0] ?? '—'}{compilation ? ` · compiled ${formatDateTime(compilation.created_at) ?? ''}` : ''}
              {' '}<Link to={problemPath(org, item.slug, 'source', { version: revision.revision })} viewTransition>Open source</Link>
            </dd>
          </div>
        </dl>
      </section>
      <div className="case-copyline">
        <Action variant="secondary" onClick={() => void copy(`${item.slug}@${revision.revision} ${revision.package_digest}`, 'reference')}>
          {status('reference') === 'copied' ? 'Reference copied' : status('reference') === 'failed' ? 'Copy failed' : 'Copy exact reference'}
        </Action>
        <span className="org-muted">The reference points at exactly this content, forever.</span>
      </div>

      <section className="org-section" aria-labelledby="rv-workflow">
        <h2 id="rv-workflow">How the service works</h2>
        {modelState.status === 'loading' && <div role="status" aria-busy="true"><span className="sr-only">Reading the compiled form…</span><Skeleton variant="panel" /></div>}
        {modelState.data?.state === 'failed' && (
          <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={modelState.reload}>Retry</Action>}>
            The compiled form couldn’t be read{marker(modelState.data.failure)}.{modelState.data.failure.code === 'revision_not_recompilable' ? ' The installed toolchain refuses this package; it stays as evidence.' : ''}
          </Notice>
        )}
        {modelState.data?.state === 'ready' && !model && <p className="org-muted">The compiled form isn’t a binding problem this page can draw.</p>}
        {model && (
          <div className="proj-panel">
            <div className="case-flow-head"><b>Workflow</b><span>· profile {model.profile ?? 'not stated'}</span></div>
            <FlowDrawing flow={model.flow} caption={<span>Possible combinations ≈ <Power log10={model.log10} /></span>} />
          </div>
        )}
      </section>

      {model && (
        <section className="org-section" aria-labelledby="rv-model">
          <h2 id="rv-model">Providers, rules and goal</h2>
          <div className="case-model">
            <CandidateTable model={model} />
            <div className="case-model-side">
              <RulesCard model={model} />
              <GoalCard model={model} />
              <PlacementCard model={model} />
            </div>
          </div>
        </section>
      )}

    </>
  );
}
