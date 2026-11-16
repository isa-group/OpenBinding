import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import type { ProblemCompilation, ProblemRevision as Revision } from '../../api/problems';
import { BindingSpaceBadge } from '../../components/BindingSpaceBadge/BindingSpaceBadge';
import { Action } from '../../modules/core/components/action-button';
import { Notice } from '../../modules/core/components/notice';
import { Skeleton } from '../../modules/core/components/skeleton';
import { useCopy } from '../../modules/core/hooks/useCopy';
import { workflowGraph, type TaskOverlay } from '../../entities/binding/workflowGraph';
import { problemPath } from '../../routes/paths/problems';
import { formatBytes, formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { RulesAndObjectives } from '../../widgets/rules-and-objectives/RulesAndObjectives';
import { WorkflowGraph } from '../../widgets/workflow-graph/WorkflowGraph';
import { marker } from '../../modules/core/api/errors';
import { loadModel, modelKey, type ModelState } from './modelLoader';
import { DigestLine } from './parts';
import type { RouteProblemContent } from './useRouteProblem';

/** The languages the compiler read the package in: the `apiVersion` of each resource the compilation lists, each once. */
function languagesOf(compilation: ProblemCompilation | null): string[] {
  return [
    ...new Set(
      Object.values(compilation?.resources ?? {}).flatMap(contract =>
        contract.apiVersion ? [contract.apiVersion] : []
      )
    ),
  ];
}

/** Whether the version declares placement: the compilation's analysis says so; the facts carry no pools. */
function PlacementCard({ compilation }: { compilation: ProblemCompilation }) {
  return compilation.analysis.placement ? (
    <div className="case-dashed">
      <b>Placement</b> · declared in this version (pools, network or events). The compiled form
      holds the details.
    </div>
  ) : (
    <div className="case-dashed">
      <b>Placement</b> · not declared in this version (no pools, network or events).
    </div>
  );
}

/** The Overview tab of the problem page: the problem version on show, its workflow, and its rules and objectives, in plain language. */
export function VersionOverview({
  organization,
  content,
  revision,
}: {
  organization: Organization;
  content: RouteProblemContent;
  revision: Revision;
}) {
  const { copy, status } = useCopy();
  const { item } = content;
  const org = organization.slug;
  const modelState = useResource<ModelState>(modelKey(org, item.slug, revision), () =>
    loadModel(org, item.slug, revision.revision)
  );

  const facts = modelState.data?.state === 'ready' ? modelState.data.facts : null;
  const compilation = modelState.data?.state === 'ready' ? modelState.data.compilation : null;
  const languages = languagesOf(compilation);
  const graph = useMemo(() => (facts ? workflowGraph(facts.workflow) : null), [facts]);
  const overlay = useMemo(
    () =>
      Object.fromEntries(
        (facts?.tasks ?? []).map((task): [string, TaskOverlay] => [
          task.id,
          { local: task.kind === 'local' },
        ])
      ),
    [facts]
  );

  return (
    <>
      <section aria-labelledby="rv-identity">
        <h2 id="rv-identity" className="sr-only">
          Identity
        </h2>
        <dl className="case-identity">
          <div>
            <dt>Package fingerprint</dt>
            <dd>
              <DigestLine
                digest={revision.package_digest}
                label={`version ${revision.revision}`}
                copyKey="digest"
              />
            </dd>
          </div>
          <div>
            <dt>Sealed</dt>
            <dd>{formatDateTime(revision.created_at) ?? '—'}</dd>
          </div>
          <div>
            <dt>Languages</dt>
            <dd>{languages.length ? languages.join(', ') : 'not stated'}</dd>
          </div>
          <div>
            <dt>Package</dt>
            <dd>
              {formatBytes(revision.package_size)?.split(' (')[0] ?? '—'}
              {compilation
                ? ` · compiled ${formatDateTime(compilation.created_at) ?? ''}`
                : ''}{' '}
              <Link
                to={problemPath(org, item.slug, 'source', { version: revision.revision })}
                viewTransition
              >
                Open source
              </Link>
            </dd>
          </div>
        </dl>
      </section>
      <div className="case-copyline">
        <Action
          variant="secondary"
          onClick={() =>
            void copy(`${item.slug}@${revision.revision} ${revision.package_digest}`, 'reference')
          }
        >
          {status('reference') === 'copied'
            ? 'Reference copied'
            : status('reference') === 'failed'
              ? 'Copy failed'
              : 'Copy exact reference'}
        </Action>
        <span className="org-muted">The reference points at exactly this content, forever.</span>
      </div>

      <section className="org-section" aria-labelledby="rv-workflow">
        <h2 id="rv-workflow">How the service works</h2>
        {modelState.status === 'loading' && (
          <div role="status" aria-busy="true">
            <span className="sr-only">Reading the compiled form…</span>
            <Skeleton variant="panel" />
          </div>
        )}
        {modelState.data?.state === 'failed' && (
          <Notice
            tone="warning"
            action={
              <Action variant="secondary" size="sm" onClick={modelState.reload}>
                Retry
              </Action>
            }
          >
            The compiled form couldn’t be read{marker(modelState.data.failure)}.
            {modelState.data.failure.code === 'revision_not_recompilable'
              ? ' The installed toolchain refuses this package; it stays as evidence.'
              : ''}
          </Notice>
        )}
        {facts && compilation && graph && (
          <div className="proj-panel">
            <div className="case-flow-head">
              <b>Workflow</b>
              <span>· possible combinations</span>
              {facts.binding_space ? (
                <BindingSpaceBadge cardinality={facts.binding_space} />
              ) : (
                <span>not measured</span>
              )}
            </div>
            <WorkflowGraph graph={graph} overlay={overlay} label="Workflow" />
          </div>
        )}
      </section>

      {facts && compilation && (
        <>
          <RulesAndObjectives facts={facts} />
          <PlacementCard compilation={compilation} />
          <p className="org-muted">
            The candidates of each task, with the values the package writes for them, are on the{' '}
            <Link
              to={problemPath(org, item.slug, 'candidates', { version: revision.revision })}
              viewTransition
            >
              Candidates
            </Link>{' '}
            tab.
          </p>
        </>
      )}
    </>
  );
}
