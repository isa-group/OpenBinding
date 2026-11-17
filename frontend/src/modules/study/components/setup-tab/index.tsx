// The Setup tab of the study page: the definition as a matrix, its runs, the definition's digest and the way to edit it, and
// what the shown run froze. Pattern only, after the cards of SPHERE frontend/src/modules/pricing/pages/collection-card/index.tsx
// (revision 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the
// full text is in THIRD_PARTY_NOTICES.md.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { SourceView } from '../../../../components/rendering/SourceView';
import { formatDateTime } from '../../../../utils/format';
import { useResource, type Resource } from '../../../../utils/useResource';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { TabBar, TabPanel } from '../../../core/components/tab-bar';
import { studiesApi, type Study, type StudyCell, type StudyRun } from '../../api/studiesApi';
import { useRevisionIndex } from '../../hooks/useRevisionIndex';
import type { StudyScopeValue } from '../../pages/card/hooks';
import {
  definitionGrid,
  definitionOfRun,
  definitionSize,
  describeParameters,
  engineRowLabel,
  formulaOf,
  frozenEngineFacts,
  isPresetEngine,
  plural,
  revisionLabel,
  sameDefinition,
  studyPageHref,
} from '../../utils/studiesModel';
import { CARD, CARD_TITLE, MUTED } from '../../utils/ui';
import { CopyDigest } from '../copy-digest';
import { CellBar, StateChip } from '../study-state';

/** How many of the newest runs show their cells as a bar; older ones show only their state. */
const RUNS_WITH_BARS = 5;

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'source', label: 'Source' },
];

function DefinitionMatrix({ definition, org }: { definition: Study['definition']; org: string }) {
  const { index } = useRevisionIndex(org);
  const grid = definitionGrid(definition);
  const size = definitionSize(definition);
  const seeds = [...definition.seeds].sort((a, b) => a - b);
  const settings = definition.parameter_sets ?? [];
  const presets = (definition.engines ?? []).filter(isPresetEngine).map(engine => engine.preset);
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-labelledby="study-matrix-title">
      <h2 id="study-matrix-title" className={CARD_TITLE}>
        The matrix
      </h2>
      {grid.columns.length <= 200 ? (
        <div
          className="max-w-full overflow-x-auto rounded-lg border border-tp-hairline-soft"
          tabIndex={0}
          role="region"
          aria-label="The cells of the matrix"
        >
          <table className="w-full border-separate border-spacing-1 text-xs">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-medium text-tp-steel">
                  Problem ↓ · engine × seed →
                </th>
                {grid.columns.map(column => (
                  <th
                    key={column.key}
                    scope="col"
                    className="min-w-24 px-2 py-1 text-left align-bottom font-medium text-tp-steel"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, rowPosition) => (
                <tr key={row}>
                  <th
                    scope="row"
                    className="px-2 py-1 text-left font-medium whitespace-nowrap text-tp-ink"
                  >
                    {revisionLabel(index, row, true)}
                  </th>
                  {grid.columns.map((column, columnPosition) => (
                    <td
                      key={column.key}
                      className="rounded-md border border-tp-hairline-soft bg-tp-surface px-2 py-1.5 text-center text-tp-slate"
                    >
                      {grid.numbered
                        ? `cell ${rowPosition * grid.columns.length + columnPosition}`
                        : '·'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={MUTED}>
          This matrix has {grid.columns.length.toLocaleString('en-US')} columns, too many to draw.
          Its runs list every cell.
        </p>
      )}
      <span className={MUTED}>
        {formulaOf(size)} = {plural(size.cells, 'cell')}.
        {settings.length > 0 &&
          ` Settings: ${settings.map((item, position) => `${position + 1} · ${describeParameters(item).toLowerCase()}`).join('; ')}.`}
        {seeds.length > 0 && ` Seeds: ${seeds.join(', ')}.`}
        {presets.length > 0 &&
          ` Each run expands the run preset${presets.length === 1 ? '' : 's'} ${presets.join(', ')} into the engine, mode and options it holds then.`}{' '}
        Every run repeats exactly these cells.
      </span>
    </section>
  );
}

function RunsCard({ scope, runs }: { scope: StudyScopeValue; runs: Resource<StudyRun[]> }) {
  const { study, organization, studyPath } = scope;
  const list = runs.data ?? runs.stale;
  // The newest runs show their cells as a bar; reading them waits for the Setup tab, which is the only one that draws them.
  const newest = (list ?? []).slice(0, RUNS_WITH_BARS);
  const bars = useResource<Record<string, StudyCell[]>>(
    `study-run-bars:${study.id}:${newest.map(run => run.id).join(',')}`,
    async () => {
      const entries = await Promise.all(
        newest.map(
          async run =>
            [
              run.id,
              await studiesApi.cells(organization.slug, study.slug, run.id).catch(() => undefined),
            ] as const
        )
      );
      return Object.fromEntries(
        entries.filter((entry): entry is readonly [string, StudyCell[]] => entry[1] !== undefined)
      );
    }
  );
  const data = list ? { runs: list, cells: bars.data ?? bars.stale ?? {} } : undefined;
  const failure = runs.status === 'error' ? classifyAuthError(runs.error) : null;
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-labelledby="study-runs-title">
      <h2 id="study-runs-title" className={CARD_TITLE}>
        Runs
      </h2>
      {runs.status === 'loading' && !data && (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the runs…</span>
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && !data && (
        <Notice
          tone="error"
          action={
            <Action variant="secondary" size="sm" onClick={runs.reload}>
              Retry
            </Action>
          }
        >
          {failure.status === 403
            ? `This key can’t read the runs${marker(failure)}.`
            : `The runs couldn’t be loaded${marker(failure)}.`}
        </Notice>
      )}
      {data && data.runs.length === 0 && (
        <p className={MUTED}>
          No runs yet. Running uses 1 study run from your month and runs up to{' '}
          {plural(definitionSize(study.definition).cells, 'cell')}.
        </p>
      )}
      {data && data.runs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.runs.map(run => {
            const cells = data.cells[run.id];
            const finished = formatDateTime(run.finished_at);
            return (
              <li key={run.id}>
                <Link
                  to={studyPageHref(studyPath, 'progress', { run: run.id })}
                  viewTransition
                  className="flex cursor-pointer flex-col gap-1.5 rounded-lg border border-tp-hairline px-3 py-2 transition-colors hover:border-tp-hairline-strong hover:bg-tp-surface"
                >
                  <span className="flex items-center justify-between gap-2">
                    <strong className="text-sm font-medium text-tp-ink">
                      Run #{run.run_number}
                    </strong>
                    <StateChip state={run.state} />
                  </span>
                  <small className={MUTED}>
                    {formatDateTime(run.created_at) ?? '—'}
                    {finished ? ` → ${finished}` : ''} · {plural(run.cells, 'cell')}
                  </small>
                  {cells && cells.length > 0 && <CellBar cells={cells} size="sm" />}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The current definition: its digest, and the way to edit it. A run keeps the copy it froze, so editing never changes a run. */
function DefinitionCard({
  scope,
  onEdit,
  busy,
}: {
  scope: StudyScopeValue;
  onEdit: () => void;
  busy: boolean;
}) {
  const { study, access } = scope;
  return (
    <section
      className={`${CARD} flex flex-col items-start gap-3`}
      aria-labelledby="study-definition-title"
    >
      <h2 id="study-definition-title" className={CARD_TITLE}>
        Definition
      </h2>
      <span className={MUTED}>
        Each run freezes the definition it starts with, and the compilation of every problem
        version, so editing it here changes only the runs that start afterwards.
      </span>
      <CopyDigest value={study.definition_digest} label="Copy the definition digest" />
      {access.canCreate && (
        <Action variant="secondary" size="sm" disabled={study.archived || busy} onClick={onEdit}>
          Edit definition
        </Action>
      )}
      {!access.canCreate && <span className={MUTED}>Editing it needs MEMBER.</span>}
    </section>
  );
}

/** What the selected run froze: its problem versions with the compilation each runs, and the way back to that matrix. */
function FrozenDefinition({
  scope,
  run,
  onRestore,
  busy,
}: {
  scope: StudyScopeValue;
  run: StudyRun;
  onRestore: (run: StudyRun) => void;
  busy: boolean;
}) {
  const { access, study, organization } = scope;
  const { index } = useRevisionIndex(organization.slug);
  const definition = definitionOfRun(run);
  const same = sameDefinition(definition, study.definition);
  return (
    <section
      className={`${CARD} flex flex-col items-start gap-3`}
      aria-labelledby="study-frozen-title"
    >
      <div>
        <h2 id="study-frozen-title" className={CARD_TITLE}>
          Frozen definition
        </h2>
        <span className={MUTED}>
          What run #{run.run_number} froze when it started. Editing the study does not change it.
        </span>
      </div>
      <CopyDigest value={run.definition_digest} label="Copy the digest of the frozen definition" />
      <ul
        className="flex flex-col gap-1 text-sm text-tp-ink"
        aria-label="Problem versions of the run"
      >
        {run.definition.problems.map(problem => (
          <li key={problem.revisionId}>
            <span>{revisionLabel(index, problem.revisionId, true)}</span>{' '}
            <small className={MUTED}>compiled once for this run · </small>
            <CopyDigest
              value={problem.compilationDigest}
              label={`Copy the compilation digest of ${revisionLabel(index, problem.revisionId, true)}`}
            />
          </li>
        ))}
      </ul>
      <ul className="flex flex-col gap-1 text-sm text-tp-ink" aria-label="Engines of the run">
        {run.definition.engines.map((engine, position) => {
          const facts = frozenEngineFacts(engine);
          return (
            <li key={`${engineRowLabel(engine)}-${position}`}>
              <span>{engineRowLabel(engine)}</span>
              <small className={`block ${MUTED}`}>
                Options: {facts.options}
                {facts.optimization ? ` · optimization ${facts.optimization}` : ''}
                {facts.preset
                  ? ` · from the run preset ${facts.preset}, as it was when the run started`
                  : ''}
              </small>
            </li>
          );
        })}
      </ul>
      <span className={MUTED}>
        {formulaOf(definitionSize(definition))}: this run expanded exactly these cells.
      </span>
      {access.canCreate && !same && (
        <Action
          variant="secondary"
          size="sm"
          disabled={study.archived || busy}
          onClick={() => onRestore(run)}
        >
          Use it for the next runs
        </Action>
      )}
      {same && <span className={MUTED}>The study’s current definition is this one.</span>}
    </section>
  );
}

/** The Setup tab: the definition as Overview (matrix, runs, definition, the shown run's frozen copy) and Source. */
export function SetupTab({
  scope,
  runs,
  shownRun,
  onEdit,
  onRestore,
  busy,
}: {
  scope: StudyScopeValue;
  runs: Resource<StudyRun[]>;
  shownRun: StudyRun | undefined;
  onEdit: () => void;
  onRestore: (run: StudyRun) => void;
  busy: boolean;
}) {
  const { study, organization } = scope;
  const [view, setView] = useState<'overview' | 'source'>('overview');
  return (
    <div className="flex flex-col gap-4">
      <TabBar
        items={VIEWS}
        value={view}
        onChange={id => setView(id as 'overview' | 'source')}
        ariaLabel="Study views"
        prefix="study-view"
      />
      <TabPanel prefix="study-view" active={view}>
        {view === 'overview' ? (
          <div className="flex flex-col gap-4">
            <DefinitionMatrix definition={study.definition} org={organization.slug} />
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <RunsCard scope={scope} runs={runs} />
              <DefinitionCard scope={scope} onEdit={onEdit} busy={busy} />
            </div>
            {shownRun && (
              <FrozenDefinition scope={scope} run={shownRun} onRestore={onRestore} busy={busy} />
            )}
          </div>
        ) : (
          <SourceView
            source={study.definition}
            label="Study definition source"
            filename={`${study.slug}.definition.json`}
          />
        )}
      </TabPanel>
    </div>
  );
}
