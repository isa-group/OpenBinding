import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { HttpError } from '../../api/client';
import { platformApi, type Study, type StudyCell, type StudyRun } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Notice } from '../../components/ui/Notice';
import { SourceView } from '../../components/rendering/SourceView';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { formatDateTime } from '../../utils/format';
import { useResource, type Resource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../../shared/api/errors';
import { RefusalNotice } from '../Runs/parts';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { studiesPath } from '../../routes/paths/studies';
import { CellBar, StateChip, StudyFrame } from './parts';
import { CellPanel } from './StudyCell';
import { CopyDigest } from './CopyDigest';
import { StudyScope, type StudyScopeValue } from './StudyScope';
import { RunResults } from './StudyAnalytics';
import { RunProgress } from './StudyRun';
import {
  STUDY_TABS,
  definitionGrid,
  definitionOfRun,
  definitionSize,
  describeParameters,
  engineRowLabel,
  formulaOf,
  frozenEngineFacts,
  isPresetEngine,
  isStudyTab,
  plural,
  revisionLabel,
  sameDefinition,
  stateWord,
  studyPageHref,
  type StudyTabId,
} from './studiesModel';
import { studyRefusal, type Refusal } from './studyErrors';
import { useRevisionIndex } from './useRevisionIndex';

/** How many of the newest runs show their cells as a bar; older ones show only their state. */
const RUNS_WITH_BARS = 5;

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'source', label: 'Source' },
];

type Outcome =
  | { tone: 'success'; text: string; follow?: { to: string; label: string } }
  | { tone: 'error'; refusal: Refusal };

function DefinitionMatrix({ definition, org }: { definition: Study['definition']; org: string }) {
  const { index } = useRevisionIndex(org);
  const grid = definitionGrid(definition);
  const size = definitionSize(definition);
  const seeds = [...definition.seeds].sort((a, b) => a - b);
  const settings = definition.parameter_sets ?? [];
  const presets = (definition.engines ?? []).filter(isPresetEngine).map(engine => engine.preset);
  return (
    <section className="st-card" aria-labelledby="st-matrix-title">
      <h2 id="st-matrix-title">The matrix</h2>
      {grid.columns.length <= 200 ? (
        <div
          className="st-grid-scroll"
          tabIndex={0}
          role="region"
          aria-label="The cells of the matrix"
        >
          <table className="st-grid">
            <thead>
              <tr>
                <th scope="col">Problem ↓ · engine × seed →</th>
                {grid.columns.map(column => (
                  <th key={column.key} scope="col" className="st-grid-head">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, rowPosition) => (
                <tr key={row}>
                  <th scope="row">{revisionLabel(index, row, true)}</th>
                  {grid.columns.map((column, columnPosition) => (
                    <td key={column.key} className="st-grid-cell">
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
        <p className="org-muted">
          This matrix has {grid.columns.length.toLocaleString('en-US')} columns, too many to draw.
          Its runs list every cell.
        </p>
      )}
      <span className="st-caption">
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
              await platformApi
                .studyCells(organization.slug, study.slug, run.id)
                .catch(() => undefined),
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
    <section className="st-card" aria-labelledby="st-runs-title">
      <h2 id="st-runs-title">Runs</h2>
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
        <p className="org-muted">
          No runs yet. Running uses 1 study run from your month and runs up to{' '}
          {plural(definitionSize(study.definition).cells, 'cell')}.
        </p>
      )}
      {data && data.runs.length > 0 && (
        <ul className="st-runs">
          {data.runs.map(run => {
            const cells = data.cells[run.id];
            const finished = formatDateTime(run.finished_at);
            return (
              <li key={run.id}>
                <Link
                  to={studyPageHref(studyPath, 'progress', { run: run.id })}
                  viewTransition
                  className="st-run-link"
                >
                  <span className="st-run-head">
                    <strong>Run #{run.run_number}</strong>
                    <StateChip state={run.state} />
                  </span>
                  <small>
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
    <section className="st-card" aria-labelledby="st-definition-title">
      <h2 id="st-definition-title">Definition</h2>
      <span className="st-caption">
        Each run freezes the definition it starts with, and the compilation of every problem
        version, so editing it here changes only the runs that start afterwards.
      </span>
      <span>
        <CopyDigest value={study.definition_digest} label="Copy the definition digest" />
      </span>
      {access.canCreate && (
        <Action variant="secondary" size="sm" disabled={study.archived || busy} onClick={onEdit}>
          Edit definition
        </Action>
      )}
      {!access.canCreate && <span className="st-caption">Editing it needs MEMBER.</span>}
    </section>
  );
}

/** The Setup tab: the definition as the M2.5 pair, Overview (matrix, runs, definition) and Source. */
function SetupTab({
  scope,
  runs,
  onEdit,
  busy,
}: {
  scope: StudyScopeValue;
  runs: Resource<StudyRun[]>;
  onEdit: () => void;
  busy: boolean;
}) {
  const { study, organization } = scope;
  const [view, setView] = useState<'overview' | 'source'>('overview');
  return (
    <>
      <TabBar
        items={VIEWS}
        value={view}
        onChange={id => setView(id as 'overview' | 'source')}
        ariaLabel="Study views"
        prefix="st-view"
      />
      <TabPanel prefix="st-view" active={view}>
        {view === 'overview' ? (
          <>
            <DefinitionMatrix definition={study.definition} org={organization.slug} />

            <div className="st-two">
              <RunsCard scope={scope} runs={runs} />
              <DefinitionCard scope={scope} onEdit={onEdit} busy={busy} />
            </div>
          </>
        ) : (
          <SourceView
            source={study.definition}
            label="Study definition source"
            filename={`${study.slug}.definition.json`}
          />
        )}
      </TabPanel>
    </>
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
    <section className="st-card st-frozen" aria-labelledby="st-frozen-title">
      <h2 id="st-frozen-title">Frozen definition</h2>
      <span className="st-caption">
        What this run froze when it started. Editing the study does not change it.
      </span>
      <span>
        <CopyDigest
          value={run.definition_digest}
          label="Copy the digest of the frozen definition"
        />
      </span>
      <ul className="st-frozen-problems" aria-label="Problem versions of the run">
        {run.definition.problems.map(problem => (
          <li key={problem.revisionId}>
            <span>{revisionLabel(index, problem.revisionId, true)}</span>{' '}
            <small className="org-muted">compiled once for this run · </small>
            <CopyDigest
              value={problem.compilationDigest}
              label={`Copy the compilation digest of ${revisionLabel(index, problem.revisionId, true)}`}
            />
          </li>
        ))}
      </ul>
      <ul className="st-frozen-engines" aria-label="Engines of the run">
        {run.definition.engines.map((engine, position) => {
          const facts = frozenEngineFacts(engine);
          return (
            <li key={`${engineRowLabel(engine)}-${position}`}>
              <span>{engineRowLabel(engine)}</span>
              <small className="org-muted">
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
      <span className="st-caption">
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
      {same && <span className="st-caption">The study’s current definition is this one.</span>}
    </section>
  );
}

function NoRuns() {
  return (
    <p className="org-muted">
      This study has no run yet. Start one with Run study; its progress and results appear here.
    </p>
  );
}

function DetailBody({ scope, tab }: { scope: StudyScopeValue; tab: StudyTabId | undefined }) {
  const { study, organization, access, etag, studyPath, reloadStudy } = scope;
  const org = organization.slug;
  const navigate = useNavigate();
  const [query, setQuery] = useSearchParams();
  const runs = useResource<StudyRun[]>(`study-runs:${study.id}`, async () => {
    const list = await platformApi.studyRuns(org, study.slug);
    return [...list].sort((a, b) => b.run_number - a.run_number);
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'run' | 'archive' | 'definition' | 'delete' | null>(null);
  const [editing, setEditing] = useState(false);
  const [editingDefinition, setEditingDefinition] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The study run shown: the one the address names, else the latest. The default tab is Progress for a study with runs, else Setup.
  const runList = runs.data ?? runs.stale;
  const named = query.get('run') ?? '';
  const runId = named || runList?.[0]?.id || '';
  const cellId = query.get('cell') ?? '';
  // Every tab but Setup needs to know the run: until the list says which, or when it can't, the tab has nothing true to say about runs.
  const needsList = tab !== 'setup' && !named && !runList;
  const waiting = needsList && runs.status === 'loading';
  const listFailure = needsList && runs.status === 'error' ? classifyAuthError(runs.error) : null;
  const active: StudyTabId = tab ?? (runList && runList.length > 0 ? 'progress' : 'setup');

  const shownRun = runList?.find(item => item.id === runId);
  const settle = (next: Outcome | null) => {
    setOutcome(next);
    setBusy(null);
  };

  const run = async () => {
    setBusy('run');
    setOutcome(null);
    try {
      const made = await platformApi.runStudy(org, study.slug);
      settle({
        tone: 'success',
        text: `Run #${made.run_number} accepted (202). Cells start as run slots free up.`,
        follow: {
          to: studyPageHref(studyPath, 'progress', { run: made.id }),
          label: `Follow run #${made.run_number}`,
        },
      });
      runs.reload();
    } catch (caught) {
      settle({ tone: 'error', refusal: studyRefusal(caught, 'run') });
    }
  };

  const archive = async () => {
    setBusy('archive');
    setOutcome(null);
    try {
      await platformApi.updateStudy(org, study.slug, { archived: !study.archived });
      settle({
        tone: 'success',
        text: study.archived
          ? 'Restored. It can start new runs again.'
          : 'Archived: it can’t start new runs, and existing results stay.',
      });
      reloadStudy();
    } catch (caught) {
      settle({ tone: 'error', refusal: studyRefusal(caught, 'archive') });
    }
  };

  const restore = async (from: StudyRun) => {
    setBusy('definition');
    setOutcome(null);
    try {
      await platformApi.updateStudy(org, study.slug, { definition: definitionOfRun(from) }, etag);
      settle({
        tone: 'success',
        text: `The study’s definition is now the one run #${from.run_number} froze. Earlier runs keep the definitions they ran with.`,
      });
      reloadStudy();
    } catch (caught) {
      settle({ tone: 'error', refusal: studyRefusal(caught, 'update') });
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await platformApi.deleteStudy(org, study.slug);
      void navigate(studiesPath(org), { viewTransition: true });
    } catch (caught) {
      setDeleting(false);
      if (
        caught instanceof HttpError &&
        caught.status === 409 &&
        caught.code === 'study_history_retained'
      ) {
        try {
          await platformApi.updateStudy(org, study.slug, { archived: true });
          settle({
            tone: 'success',
            text: 'This study has runs, so it was archived instead of deleted. Its runs and results stay intact.',
          });
          reloadStudy();
        } catch (second) {
          settle({ tone: 'error', refusal: studyRefusal(second, 'archive') });
        }
      } else {
        settle({ tone: 'error', refusal: studyRefusal(caught, 'delete') });
      }
    }
  };

  return (
    <StudyFrame
      organization={organization}
      trail={[{ label: 'Studies', to: studiesPath(org) }, { label: study.name }]}
    >
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>{study.name}</h1>
            {study.archived && <Chip>Archived</Chip>}
          </div>
          <p>
            {formulaOf(definitionSize(study.definition))} ={' '}
            {plural(definitionSize(study.definition).cells, 'cell')}
          </p>
          {study.description && <p>{study.description}</p>}
        </div>
        <div className="proj-actions">
          {access.canCreate && (
            <>
              <Action
                variant="primary"
                busy={busy === 'run'}
                disabled={study.archived || busy !== null}
                onClick={() => void run()}
              >
                Run study
              </Action>
              <Action
                variant="secondary"
                busy={busy === 'archive'}
                disabled={busy !== null}
                onClick={() => void archive()}
              >
                {study.archived ? 'Restore' : 'Archive'}
              </Action>
              <Action variant="secondary" disabled={busy !== null} onClick={() => setEditing(true)}>
                Edit details
              </Action>
            </>
          )}
          {access.canAdminister && (
            <Action
              variant="danger-outline"
              disabled={busy !== null}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Action>
          )}
        </div>
      </header>

      {outcome?.tone === 'success' && (
        <Notice
          tone="success"
          action={
            outcome.follow ? (
              <Action to={outcome.follow.to} variant="link" size="sm">
                {outcome.follow.label}
              </Action>
            ) : undefined
          }
        >
          {outcome.text}
        </Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
      {study.archived && (
        <Notice tone="info">
          Archived studies keep their runs and results but can’t start new runs until restored.
        </Notice>
      )}
      {!access.canCreate && (
        <p className="org-muted">
          You can read this study. Running, archiving and editing it need MEMBER in{' '}
          {organization.name}.
        </p>
      )}

      {waiting ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the runs…</span>
          <Skeleton variant="panel" />
        </div>
      ) : (
        <>
          {runList && runList.length > 0 && (
            <label className="job-select st-run-pick">
              <span>Study run</span>
              <select
                aria-label="Study run"
                value={runList.some(item => item.id === runId) ? runId : ''}
                onChange={event => setQuery({ run: event.target.value })}
              >
                {!runList.some(item => item.id === runId) && <option value="">Choose a run</option>}
                {runList.map(item => (
                  <option key={item.id} value={item.id}>
                    Run #{item.run_number} · {stateWord(item.state).label}
                  </option>
                ))}
              </select>
            </label>
          )}

          <TabBar
            items={STUDY_TABS}
            value={active}
            onChange={id =>
              void navigate(studyPageHref(studyPath, id as StudyTabId, { run: named }), {
                viewTransition: true,
              })
            }
            ariaLabel="Study sections"
            prefix="st-tab"
          />
          <TabPanel prefix="st-tab" active={active}>
            {active === 'setup' && (
              <SetupTab
                scope={scope}
                runs={runs}
                onEdit={() => setEditingDefinition(true)}
                busy={busy !== null}
              />
            )}
            {active !== 'setup' && listFailure && (
              <Notice
                tone="error"
                action={
                  <Action variant="secondary" size="sm" onClick={runs.reload}>
                    Retry
                  </Action>
                }
              >
                {listFailure.status === 403
                  ? `This key can’t read the runs${marker(listFailure)}.`
                  : `The runs couldn’t be loaded${marker(listFailure)}.`}
              </Notice>
            )}
            {active !== 'setup' && !listFailure && (
              <>
                {shownRun && (
                  <FrozenDefinition
                    scope={scope}
                    run={shownRun}
                    onRestore={from => void restore(from)}
                    busy={busy !== null}
                  />
                )}
                {active === 'progress' &&
                  (runId ? <RunProgress key={runId} scope={scope} runId={runId} /> : <NoRuns />)}
                {active === 'results' &&
                  (runId ? (
                    cellId ? (
                      <CellPanel
                        key={`${runId}/${cellId}`}
                        scope={scope}
                        runId={runId}
                        cellId={cellId}
                      />
                    ) : (
                      <RunResults key={runId} scope={scope} runId={runId} />
                    )
                  ) : (
                    <NoRuns />
                  ))}
              </>
            )}
          </TabPanel>
        </>
      )}

      {editing && (
        <EditDialog
          study={study}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            settle({ tone: 'success', text: 'Details saved.' });
            reloadStudy();
          }}
          org={org}
        />
      )}
      {editingDefinition && (
        <DefinitionDialog
          study={study}
          etag={etag}
          org={org}
          onClose={() => setEditingDefinition(false)}
          onSaved={() => {
            setEditingDefinition(false);
            settle({
              tone: 'success',
              text: 'Definition saved. The next run uses it; earlier runs keep the definitions they ran with.',
            });
            reloadStudy();
          }}
        />
      )}
      {deleting && (
        <Modal
          title={`Delete ${study.name}?`}
          tone="danger"
          onClose={() => busy === null && setDeleting(false)}
        >
          <p>
            The definition goes away for good. A study that already has runs can’t be deleted,
            because runs are history: it is archived instead, and its results stay.
          </p>
          <div className="ui-modal-actions">
            <Action
              variant="secondary"
              onClick={() => setDeleting(false)}
              disabled={busy === 'delete'}
            >
              Cancel
            </Action>
            <Action variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
              Delete study
            </Action>
          </div>
        </Modal>
      )}
    </StudyFrame>
  );
}

function EditDialog({
  study,
  org,
  onClose,
  onSaved,
}: {
  study: Study;
  org: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(study.name);
  const [description, setDescription] = useState(study.description);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setRefusal(null);
    try {
      await platformApi.updateStudy(org, study.slug, {
        name: name.trim(),
        description: description.trim(),
      });
      onSaved();
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'update'));
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit details" onClose={() => !busy && onClose()}>
      <form
        className="org-dialog-form"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        <FormField
          label="Name"
          value={name}
          maxLength={160}
          onChange={event => setName(event.target.value)}
          error={name.trim() ? undefined : 'A study needs a name.'}
        />
        <label className="st-description">
          <span>
            Description <span className="proj-optional">(optional)</span>
          </span>
          <textarea
            className="proj-textarea"
            rows={3}
            maxLength={2000}
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>
        {refusal && <RefusalNotice refusal={refusal} />}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            Save
          </Action>
        </div>
      </form>
    </Modal>
  );
}

/** The definition as JSON: the problem versions, engines, settings and seeds. Saved with the ETag it was read with. */
function DefinitionDialog({
  study,
  org,
  etag,
  onClose,
  onSaved,
}: {
  study: Study;
  org: string;
  etag: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(study.definition, null, 2));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const parsed = readDefinition(text);
  const save = async () => {
    if (!parsed.definition) return;
    setBusy(true);
    setRefusal(null);
    try {
      await platformApi.updateStudy(org, study.slug, { definition: parsed.definition }, etag);
      onSaved();
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'update'));
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit definition" size="lg" onClose={() => !busy && onClose()}>
      <form
        className="org-dialog-form"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        <p className="org-muted">
          The problem versions (<code>revision_ids</code>), engines, settings (
          <code>parameter_sets</code>) and seeds of the study. Runs already made keep the definition
          they froze.
        </p>
        <label className="st-description">
          <span>Definition (JSON)</span>
          <textarea
            className="proj-textarea st-definition-text"
            rows={14}
            spellCheck={false}
            value={text}
            onChange={event => {
              setText(event.target.value);
              setRefusal(null);
            }}
            aria-invalid={parsed.error ? 'true' : undefined}
          />
        </label>
        {parsed.error && <Notice tone="warning">{parsed.error}</Notice>}
        {refusal && <RefusalNotice refusal={refusal} />}
        <div className="ui-modal-actions">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action type="submit" variant="primary" busy={busy} disabled={!parsed.definition}>
            Save definition
          </Action>
        </div>
      </form>
    </Modal>
  );
}

/** A definition typed as JSON, or why it isn't one. The gateway checks the rest (that every version is the organization's, the engines). */
function readDefinition(text: string): { definition?: Study['definition']; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'This isn’t valid JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { error: 'The definition must be a JSON object.' };
  const record = value as Record<string, unknown>;
  const lists = ['revision_ids', 'engines', 'parameter_sets', 'seeds'] as const;
  const missing = lists.filter(key => !Array.isArray(record[key]));
  if (missing.length) return { error: `It needs the lists ${missing.join(', ')}.` };
  const extra = Object.keys(record).filter(key => !(lists as readonly string[]).includes(key));
  if (extra.length) return { error: `Unknown fields: ${extra.join(', ')}.` };
  return { definition: record as unknown as Study['definition'] };
}

/**
 * One study (`study-detail`, `/app/:org/studies/:study/:tab?`): Setup (the definition), Progress and Results of the study run
 * named by `?run=` (the latest when none). Any other tab is a page that does not exist.
 */
export function StudyDetail() {
  const { tab } = useParams();
  if (tab !== undefined && !isStudyTab(tab)) return <NotFoundScreen />;
  return (
    <StudyScope>{scope => <DetailBody key={scope.study.id} scope={scope} tab={tab} />}</StudyScope>
  );
}
