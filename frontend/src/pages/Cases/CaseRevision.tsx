import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { ProblemCompilation, ProblemRevision as Revision } from '../../api/problems';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { candidateMatrix } from '../../entities/binding/candidateMatrix';
import { workflowGraph, type TaskOverlay } from '../../entities/binding/workflowGraph';
import { describeExpression, isAlways } from '../../entities/problem/expressions';
import { problemPath } from '../../routes/paths/problems';
import type { ProblemFacts } from '../../shared/api/types';
import { formatBytes, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { CandidateMatrix } from '../../widgets/candidate-matrix/CandidateMatrix';
import { WorkflowGraph } from '../../widgets/workflow-graph/WorkflowGraph';
import { marker } from '../../shared/api/errors';
import { loadModel, modelKey, type ModelState } from './modelLoader';
import { DigestLine } from './parts';
import type { RouteProblemContent } from './useRouteProblem';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** The languages the compiler read the package in: the `apiVersion` of each resource the compilation lists, each once. */
function languagesOf(compilation: ProblemCompilation | null): string[] {
  return [...new Set(Object.values(compilation?.resources ?? {}).flatMap((contract) => (contract.apiVersion ? [contract.apiVersion] : [])))];
}

function RulesCard({ facts }: { facts: ProblemFacts }) {
  return (
    <section className="proj-panel" aria-labelledby="rv-rules">
      <h3 id="rv-rules">Rules</h3>
      {facts.constraints.length === 0 && <p className="org-muted">This version declares no rules.</p>}
      <ul className="case-rules">
        {facts.constraints.map((rule) => (
          <li key={rule.id}>
            <span className={`case-must${rule.enforcement === 'soft' ? ' is-should' : ''}`}>{rule.enforcement === 'hard' ? 'MUST' : 'SHOULD'}</span>
            <span>
              {describeExpression(rule.expression)}
              {rule.when !== null && !isAlways(rule.when) && <small> · when {describeExpression(rule.when)}</small>}
              {rule.penalty !== null && <small> · penalty {describeExpression(rule.penalty)} if broken</small>}
              <small className="case-rule-id">{rule.id}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoalCard({ facts }: { facts: ProblemFacts }) {
  const criteria = facts.objectives.criteria.map((criterion, index) => {
    const normalize = record(criterion.normalize);
    const min = finite(normalize.min);
    const max = finite(normalize.max);
    const id = text(criterion.id) ?? `criterion ${index + 1}`;
    return { id, feature: text(record(criterion.feature).id) ?? id, direction: text(criterion.direction), range: min !== null && max !== null ? { min, max } : null };
  });
  const penalties = facts.objectives.penalties.flatMap((penalty) => {
    const rule = text(record(penalty.constraint).id);
    const weight = finite(penalty.weight);
    return rule && weight !== null ? [{ rule, weight }] : [];
  });
  const heaviest = Math.max(...penalties.map((penalty) => penalty.weight), 0);
  return (
    <section className="proj-panel" aria-labelledby="rv-goal">
      <h3 id="rv-goal">Goal</h3>
      {criteria.length === 0 && <p className="org-muted">This version declares no criteria to optimize.</p>}
      <ul className="case-criteria">
        {criteria.map((criterion) => (
          <li key={criterion.id}>
            <span><b>{criterion.id}</b>{criterion.feature !== criterion.id ? <small> ({criterion.feature})</small> : null}</span>
            <span>{criterion.direction === 'maximize' ? 'higher is better' : criterion.direction === 'minimize' ? 'lower is better' : 'direction not stated'}{criterion.range ? ` · scaled ${criterion.range.min}–${criterion.range.max}` : ''}</span>
          </li>
        ))}
      </ul>
      {penalties.length > 0 && (
        <>
          <b className="case-sub">Breaking a “should” rule costs</b>
          <ul className="case-criteria">
            {penalties.map((penalty) => (
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

/** Whether the version declares placement: the compilation's analysis says so; the facts carry no pools. */
function PlacementCard({ compilation }: { compilation: ProblemCompilation }) {
  return compilation.analysis.placement
    ? <div className="case-dashed"><b>Placement</b> · declared in this version (pools, network or events). The compiled form holds the details.</div>
    : <div className="case-dashed"><b>Placement</b> · not declared in this version (no pools, network or events).</div>;
}

/** The Overview tab of the problem page: the model of the problem version on show, in plain language. */
export function VersionOverview({ organization, content, revision }: {
  organization: Organization; content: RouteProblemContent; revision: Revision;
}) {
  const { copy, status } = useCopy();
  const { item } = content;
  const org = organization.slug;
  const modelState = useResource<ModelState>(modelKey(org, item.slug, revision), () => loadModel(org, item.slug, revision.revision));

  const facts = modelState.data?.state === 'ready' ? modelState.data.facts : null;
  const compilation = modelState.data?.state === 'ready' ? modelState.data.compilation : null;
  const languages = languagesOf(compilation);
  const graph = useMemo(() => (facts ? workflowGraph(facts.workflow) : null), [facts]);
  const matrix = useMemo(() => (facts ? candidateMatrix(facts) : null), [facts]);
  const overlay = useMemo(() => Object.fromEntries((facts?.tasks ?? []).map((task): [string, TaskOverlay] => [task.id, { local: task.kind === 'local' }])), [facts]);

  return (
    <>

      <section aria-labelledby="rv-identity">
        <h2 id="rv-identity" className="sr-only">Identity</h2>
        <dl className="case-identity">
          <div><dt>Package fingerprint</dt><dd><DigestLine digest={revision.package_digest} label={`version ${revision.revision}`} copyKey="digest" /></dd></div>
          <div><dt>Sealed</dt><dd>{formatDateTime(revision.created_at) ?? '—'}</dd></div>
          <div>
            <dt>Languages</dt>
            <dd>{languages.length ? languages.join(', ') : 'not stated'}</dd>
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
        {facts && compilation && graph && (
          <div className="proj-panel">
            <div className="case-flow-head">
              <b>Workflow</b>
              <span>· possible combinations</span>
              {facts.binding_space ? <BindingSpaceBadge cardinality={facts.binding_space} /> : <span>not measured</span>}
            </div>
            <WorkflowGraph graph={graph} overlay={overlay} label="Workflow" />
          </div>
        )}
      </section>

      {facts && compilation && matrix && (
        <section className="org-section" aria-labelledby="rv-model">
          <h2 id="rv-model">Providers, rules and goal</h2>
          <div className="case-model">
            <section className="proj-panel" aria-labelledby="rv-candidates">
              <h3 id="rv-candidates">Candidates</h3>
              <CandidateMatrix matrix={matrix} mode="view" label="Candidates of each task" />
            </section>
            <div className="case-model-side">
              <RulesCard facts={facts} />
              <GoalCard facts={facts} />
              <PlacementCard compilation={compilation} />
            </div>
          </div>
        </section>
      )}

    </>
  );
}
