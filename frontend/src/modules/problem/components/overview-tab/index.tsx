// Pattern only, after SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the Overview tab of the problem page: the version on show (who it is, what it is made of), its workflow, and its
// rules and objectives, in plain language; OpenBinding's problem version in SPHERE's bordered card sections, the drawing and
// the rules OpenBinding's own.

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ProblemCompilation, ProblemRevision } from '../../api/problemsApi';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { RulesAndObjectives } from '../../../core/components/rules-and-objectives/RulesAndObjectives';
import { Skeleton } from '../../../core/components/skeleton';
import { WorkflowGraph } from '../../../core/components/workflow-graph/WorkflowGraph';
import { marker } from '../../../core/api/errors';
import { workflowGraph, type TaskOverlay } from '../../../core/utils/binding/workflowGraph';
import { problemPath } from '../../../../routes/paths/problems';
import { formatBytes, formatDateTime } from '../../../core/utils/format';
import type { Resource } from '../../../core/hooks/useResource';
import type { ProblemContent } from '../../types';
import type { ModelState } from '../../utils/modelLoader';
import { powerText } from '../../utils/problemsModel';

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

const CARD = 'rounded-xl border border-tp-hairline bg-tp-canvas p-4';

/** The Overview tab: the version's identity, its workflow and its rules and objectives (the compiled form is read once, by the page). */
export default function OverviewTab({
  org,
  content,
  revision,
  model,
}: {
  org: string;
  content: ProblemContent;
  revision: ProblemRevision;
  /** The compilation of the version and its facts, read by the page for its tiles. */
  model: Resource<ModelState | null>;
}) {
  const { item } = content;
  const facts = model.data?.state === 'ready' ? model.data.facts : null;
  const compilation = model.data?.state === 'ready' ? model.data.compilation : null;
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
  const identity: Array<[string, ReactNode]> = [
    ['Description', item.description || 'No description.'],
    ['Sealed', formatDateTime(revision.created_at) ?? '—'],
    ['Languages', languages.length ? languages.join(', ') : 'not stated'],
    [
      'Package',
      <>
        {formatBytes(revision.package_size)?.split(' (')[0] ?? '—'}
        {compilation ? ` · compiled ${formatDateTime(compilation.created_at) ?? ''}` : ''}{' '}
        <Link
          to={problemPath(org, item.slug, 'source', { version: revision.revision })}
          className="cursor-pointer text-tp-accent hover:underline"
        >
          Open source
        </Link>
      </>,
    ],
  ];

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="rv-identity" className={CARD}>
        <h2 id="rv-identity" className="sr-only">
          Identity
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2">
          {identity.map(([term, value]) => (
            <div key={term} className="min-w-0">
              <dt className="text-[11px] text-tp-steel">{term}</dt>
              <dd className="text-sm [overflow-wrap:anywhere] text-tp-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="rv-workflow" className="flex flex-col gap-3">
        <h2 id="rv-workflow" className="text-lg font-medium text-tp-ink">
          How the service works
        </h2>
        {model.status === 'loading' && (
          <div role="status" aria-busy="true">
            <span className="sr-only">Reading the compiled form…</span>
            <Skeleton variant="panel" />
          </div>
        )}
        {model.data?.state === 'failed' && (
          <Notice
            tone="warning"
            action={
              <Action variant="secondary" size="sm" onClick={model.reload}>
                Retry
              </Action>
            }
          >
            The compiled form couldn’t be read{marker(model.data.failure)}.
            {model.data.failure.code === 'revision_not_recompilable'
              ? ' The installed toolchain refuses this package; it stays as evidence.'
              : ''}
          </Notice>
        )}
        {facts && compilation && graph && (
          <div className={CARD}>
            <p className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-tp-steel">
              <b className="font-semibold text-tp-ink">Workflow</b>
              <span>· possible combinations</span>
              <span className="rounded-full bg-tp-surface px-2 py-0.5 font-medium text-tp-ink">
                {facts.binding_space ? `≈ ${powerText(facts.binding_space)}` : 'not measured'}
              </span>
            </p>
            <WorkflowGraph graph={graph} overlay={overlay} label="Workflow" />
          </div>
        )}
      </section>

      {facts && compilation && (
        <>
          <RulesAndObjectives facts={facts} />
          <p className="rounded-xl border border-dashed border-tp-hairline-strong p-3 text-sm text-tp-slate">
            <b className="font-semibold text-tp-ink">Placement</b> ·{' '}
            {compilation.analysis.placement
              ? 'declared in this version (pools, network or events). The compiled form holds the details.'
              : 'not declared in this version (no pools, network or events).'}
          </p>
          <p className="text-sm text-tp-steel">
            The candidates of each task, with the values the package writes for them, are on the{' '}
            <Link
              to={problemPath(org, item.slug, 'candidates', { version: revision.revision })}
              className="cursor-pointer text-tp-accent hover:underline"
            >
              Candidates
            </Link>{' '}
            tab.
          </p>
        </>
      )}
    </div>
  );
}
