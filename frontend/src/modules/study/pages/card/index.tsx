// Adapted from SPHERE frontend/src/modules/pricing/pages/collection-card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a study instead of a collection, on the shared card frame (core/components/resource-card-shell): the breadcrumb
// "Org / Study", the title with the matrix's formula and a "Study run" select, the actions (Run study, Archive or Restore,
// Edit the definition, Delete, and the Get menu with the run's exports), the stat tiles Cells, Engines, Runs and Best, and
// the tabs Setup, Progress, Results, Front and Settings, in the address (`/studies/:org/:study/:tab?`, `?run=`). A cell opens
// as a side sheet (`?cell=`). Who may do what comes from OpenBinding's roles (MEMBER runs and edits, ADMIN deletes); a study
// that is missing or another organization's is the in-place 404 (no PrivateAccessFallback). Collections' pricings, their
// DatePicker and their visibility are not brought.

import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { saveBytes } from '../../../../features/workspace/download';
import { useResource } from '../../../../utils/useResource';
import { classifyAuthError, marker, readApiError } from '../../../core/api/errors';
import { Action } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';
import { Notice } from '../../../core/components/notice';
import ResourceCardShell, {
  type OverflowAction,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import { Skeleton } from '../../../core/components/skeleton';
import CollectionCardSkeleton from '../../../core/components/skeletons/collection-card-skeleton';
import { SYSTEM_TOAST } from '../../../core/contexts/toastKinds';
import { useToast } from '../../../core/contexts/useToast';
import NotFoundPage from '../../../core/pages/page-not-found';
import customAlert from '../../../core/utils/custom-alert';
import { offerReloadIfChanged } from '../../../core/utils/offer-reload';
import { studiesPath } from '../../../../routes/paths/studies';
import {
  studiesApi,
  type Analytics,
  type Study,
  type StudyRun,
  type StudyRunExportFormat,
} from '../../api/studiesApi';
import { CellSheet } from '../../components/cell-sheet';
import GetStudyMenu from '../../components/get-study-menu';
import { FrontTab } from '../../components/pareto-front';
import { RunResults } from '../../components/results';
import { SetupTab } from '../../components/setup-tab';
import StudySettings from '../../components/study-settings';
import { RunProgress } from '../../components/study-run';
import { StudyRefusal } from '../../components/study-refusal';
import {
  STUDY_TABS,
  definitionOfRun,
  definitionSize,
  formulaOf,
  formatMeasure,
  isStudyTab,
  measureLabel,
  plural,
  stateWord,
  studyPageHref,
  type StudyTabId,
} from '../../utils/studiesModel';
import { studyRefusal, type Refusal } from '../../utils/studyErrors';
import { INPUT, MUTED } from '../../utils/ui';
import { useCardStudy, type StudyScopeValue } from './hooks';

type Outcome =
  | { tone: 'success'; text: string; follow?: { to: string; label: string } }
  | { tone: 'error'; refusal: Refusal };

const actionClass =
  'flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-input-border bg-tp-input-bg px-3 text-xs text-tp-ink transition-colors hover:bg-tp-surface focus:border-tp-primary focus:outline-none disabled:cursor-default disabled:opacity-50';

/** The lowest value of the first objective the run's analytics hold: the run's best, lower being better. */
function bestOf(analytics: Analytics | undefined): string {
  const distributions = analytics?.objective_distributions ?? {};
  const [name] = Object.keys(distributions);
  const values = name ? (distributions[name] ?? []) : [];
  if (!name || values.length === 0) return '—';
  return `${measureLabel(name)} ${formatMeasure(Math.min(...values))}`;
}

function NoRuns() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center">
      <p className="text-sm text-tp-steel">
        This study has no run yet. Start one with Run study; its progress and results appear here.
      </p>
    </div>
  );
}

function CardBody({ scope, tab }: { scope: StudyScopeValue; tab: StudyTabId | undefined }) {
  const { study, organization, access, etag, studyPath, reloadStudy } = scope;
  const org = organization.slug;
  const navigate = useNavigate();
  const location = useLocation();
  const { addToast } = useToast();
  const [query, setQuery] = useSearchParams();
  const runs = useResource<StudyRun[]>(`study-runs:${study.id}`, async () => {
    const list = await studiesApi.runs(org, study.slug);
    return [...list].sort((a, b) => b.run_number - a.run_number);
  });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'run' | 'archive' | 'definition' | 'delete' | null>(null);
  const [editingDefinition, setEditingDefinition] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The study run shown: the one the address names, else the latest. The default tab is Progress for a study with runs, else Setup.
  const runList = runs.data ?? runs.stale;
  const named = query.get('run') ?? '';
  const runId = named || runList?.[0]?.id || '';
  const cellId = query.get('cell');
  // Every tab but Setup and Settings needs to know the run: until the list says which, or when it can't, it has nothing to say.
  const runTab = tab !== 'setup' && tab !== 'settings';
  const needsList = runTab && !named && !runList;
  const waiting = needsList && runs.status === 'loading';
  const listFailure = needsList && runs.status === 'error' ? classifyAuthError(runs.error) : null;
  const active: StudyTabId = tab ?? (runList && runList.length > 0 ? 'progress' : 'setup');
  const shownRun = runList?.find(item => item.id === runId);
  const analytics = useResource<Analytics | null>(`analytics:${runId || 'none'}`, async () =>
    runId ? studiesApi.analytics(org, study.slug, runId) : null
  );

  // A message another page left for this one (the create form's) is said once, as a toast.
  const said = useRef<string | null>(null);
  const handed = (location.state as { toast?: string } | null)?.toast ?? null;
  useEffect(() => {
    if (!handed || said.current === handed) return;
    said.current = handed;
    addToast({ kind: SYSTEM_TOAST, title: handed });
  }, [handed, addToast]);

  const settle = (next: Outcome | null) => {
    setOutcome(next);
    setBusy(null);
  };

  const run = async () => {
    setBusy('run');
    setOutcome(null);
    try {
      const made = await studiesApi.start(org, study.slug);
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
      await studiesApi.update(org, study.slug, { archived: !study.archived });
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
      await studiesApi.update(org, study.slug, { definition: definitionOfRun(from) }, etag);
      settle({
        tone: 'success',
        text: `The study’s definition is now the one run #${from.run_number} froze. Earlier runs keep the definitions they ran with.`,
      });
      reloadStudy();
    } catch (caught) {
      if (offerReloadIfChanged(caught, { resource: study.name, reload: reloadStudy })) {
        settle(null);
        return;
      }
      settle({ tone: 'error', refusal: studyRefusal(caught, 'update') });
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await studiesApi.remove(org, study.slug);
      addToast({ kind: SYSTEM_TOAST, title: `Study “${study.name}” deleted.` });
      void navigate(studiesPath(org), { viewTransition: true });
    } catch (caught) {
      setDeleting(false);
      const error = readApiError(caught);
      if (error.status === 409 && error.code === 'study_history_retained') {
        try {
          await studiesApi.update(org, study.slug, { archived: true });
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

  /** The gateway's export of the shown run, fetched with the session and saved under the name the gateway gives it. */
  const exportRun = async (format: StudyRunExportFormat) => {
    if (!runId) return;
    try {
      const file = await studiesApi.exportRun(org, study.slug, runId, format);
      saveBytes(file.bytes, file.fileName, file.mediaType);
    } catch (caught) {
      void customAlert(
        `The ${format.toUpperCase()} export couldn’t be made${marker(classifyAuthError(caught))}.`,
        'error'
      );
    }
  };

  const downloadDefinition = () => {
    const text = `${JSON.stringify(study.definition, null, 2)}\n`;
    const bytes = new TextEncoder().encode(text);
    saveBytes(bytes.buffer as ArrayBuffer, `${study.slug}.definition.json`, 'application/json');
  };

  const size = definitionSize(study.definition);
  const tabTo = (id: StudyTabId) => studyPageHref(studyPath, id, { run: named || undefined });
  const tabs: ShellTab[] = STUDY_TABS.filter(
    item => item.id !== 'settings' || access.canCreate || active === 'settings'
  ).map(item => ({ id: item.id, label: item.label, to: tabTo(item.id) }));

  const overflow: OverflowAction[] = access.canCreate
    ? [
        ...(study.archived ? [] : [{ label: 'Run study', onSelect: () => void run() }]),
        { label: study.archived ? 'Restore' : 'Archive', onSelect: () => void archive() },
        { label: 'Edit', onSelect: () => setEditingDefinition(true) },
        ...(access.canAdminister ? [{ label: 'Delete', onSelect: () => setDeleting(true) }] : []),
      ]
    : [];

  const subtitle = (
    <div className="mt-1 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm text-tp-steel">
        <span
          className="rounded-lg border border-tp-input-border bg-tp-input-bg px-2 py-1 text-xs font-medium text-tp-ink"
          aria-label="Matrix"
        >
          {formulaOf(size)} = {plural(size.cells, 'cell')}
        </span>
        {runList && runList.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs">
            <span>Study run</span>
            <select
              aria-label="Study run"
              value={runList.some(item => item.id === runId) ? runId : ''}
              onChange={event =>
                setQuery(current => {
                  const next = new URLSearchParams(current);
                  next.set('run', event.target.value);
                  next.delete('cell');
                  return next;
                })
              }
              className="h-7 cursor-pointer rounded-lg border border-tp-input-border bg-tp-input-bg px-2 text-xs font-medium text-tp-ink focus:border-tp-primary focus:outline-none"
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
        {study.archived && (
          <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            Archived
          </span>
        )}
      </div>
      {study.description && <p className="text-sm text-tp-slate">{study.description}</p>}
    </div>
  );

  return (
    <>
      <Helmet>
        <title>{`OpenBinding - ${study.name}`}</title>
      </Helmet>
      <ResourceCardShell
        crumbs={[{ label: organization.name, to: studiesPath(org) }, { label: study.name }]}
        title={study.name}
        subtitle={subtitle}
        actions={
          access.canCreate && (
            <>
              <Action
                variant="primary"
                size="sm"
                busy={busy === 'run'}
                disabled={study.archived || busy !== null}
                onClick={() => void run()}
              >
                Run study
              </Action>
              <button
                type="button"
                className={actionClass}
                disabled={busy !== null}
                onClick={() => void archive()}
              >
                {busy === 'archive' ? 'Saving…' : study.archived ? 'Restore' : 'Archive'}
              </button>
              <button
                type="button"
                className={actionClass}
                disabled={study.archived || busy !== null}
                onClick={() => setEditingDefinition(true)}
              >
                Edit
              </button>
              {access.canAdminister && (
                <button
                  type="button"
                  className={`${actionClass} text-red-700 hover:bg-red-50`}
                  disabled={busy !== null}
                  onClick={() => setDeleting(true)}
                >
                  Delete
                </button>
              )}
            </>
          )
        }
        primaryAction={
          <GetStudyMenu
            runNumber={shownRun?.run_number ?? null}
            onExport={exportRun}
            onDownloadDefinition={downloadDefinition}
          />
        }
        overflow={overflow}
        stats={[
          { label: 'Cells', value: size.cells.toLocaleString('en-US') },
          { label: 'Engines', value: String(size.engines) },
          { label: 'Runs', value: runList ? String(runList.length) : '—' },
          { label: 'Best', value: bestOf(analytics.data ?? analytics.stale ?? undefined) },
        ]}
        tabs={tabs}
        activeTab={active}
        tabsLabel="Study sections"
      >
        <div className="flex flex-col gap-4">
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
          {outcome?.tone === 'error' && <StudyRefusal refusal={outcome.refusal} usageTo />}
          {study.archived && (
            <Notice tone="info">
              Archived studies keep their runs and results but can’t start new runs until restored.
            </Notice>
          )}
          {!access.canCreate && (
            <p className={MUTED}>
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
              {active === 'setup' && (
                <SetupTab
                  scope={scope}
                  runs={runs}
                  shownRun={shownRun}
                  onEdit={() => setEditingDefinition(true)}
                  onRestore={from => void restore(from)}
                  busy={busy !== null}
                />
              )}
              {active === 'settings' && (
                <StudySettings
                  key={`${study.slug}:${etag ?? ''}`}
                  scope={scope}
                  busy={busy !== null}
                  onChanged={message => {
                    settle({ tone: 'success', text: message });
                    reloadStudy();
                  }}
                  onArchive={() => void archive()}
                  onDelete={() => setDeleting(true)}
                />
              )}
              {runTab && listFailure && (
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
              {runTab && !listFailure && (
                <>
                  {active === 'progress' &&
                    (runId ? <RunProgress key={runId} scope={scope} runId={runId} /> : <NoRuns />)}
                  {active === 'results' &&
                    (runId ? <RunResults key={runId} scope={scope} runId={runId} /> : <NoRuns />)}
                  {active === 'front' &&
                    (runId ? <FrontTab key={runId} scope={scope} runId={runId} /> : <NoRuns />)}
                </>
              )}
            </>
          )}
        </div>
      </ResourceCardShell>

      {runTab && runId && <CellSheet scope={scope} runId={runId} cellId={cellId} tab={active} />}

      {editingDefinition && (
        <DefinitionDialog
          study={study}
          etag={etag}
          org={org}
          onReload={reloadStudy}
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
          <div className="flex flex-col gap-4">
            <p className="text-sm text-tp-slate">
              The definition goes away for good. A study that already has runs can’t be deleted,
              because runs are history: it is archived instead, and its results stay.
            </p>
            <div className="flex justify-end gap-2">
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
          </div>
        </Modal>
      )}
    </>
  );
}

/** The definition as JSON: the problem versions, engines, settings and seeds. Saved with the ETag it was read with. */
function DefinitionDialog({
  study,
  org,
  etag,
  onReload,
  onClose,
  onSaved,
}: {
  study: Study;
  org: string;
  etag: string | null;
  onReload: () => void;
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
      await studiesApi.update(org, study.slug, { definition: parsed.definition }, etag);
      onSaved();
    } catch (caught) {
      setBusy(false);
      if (offerReloadIfChanged(caught, { resource: study.name, reload: onReload })) {
        onClose();
        return;
      }
      setRefusal(studyRefusal(caught, 'update'));
    }
  };
  return (
    <Modal title="Edit definition" size="lg" onClose={() => !busy && onClose()}>
      <form
        className="flex flex-col gap-3"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        <p className={MUTED}>
          The problem versions (<code className="font-mono">revision_ids</code>), engines, settings
          (<code className="font-mono">parameter_sets</code>) and seeds of the study. Runs already
          made keep the definition they froze.
        </p>
        <label className="flex flex-col gap-1 text-[11px] font-medium text-tp-steel">
          <span>Definition (JSON)</span>
          <textarea
            className={`${INPUT} font-mono text-xs`}
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
        {refusal && <StudyRefusal refusal={refusal} />}
        <div className="flex justify-end gap-2">
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
 * One study (`study-detail`, `/studies/:org/:study/:tab?`): SPHERE's card page with the tabs Setup, Progress, Results, Front
 * and Settings of the study run `?run=` names (the latest when none). Any other tab, a study that is missing and one of an
 * organization that is not the account's are the same in-place 404.
 */
export default function StudyCardPage() {
  const { org = '', study: slug = '', tab } = useParams();
  const { state, reload } = useCardStudy(org, slug);
  if (tab !== undefined && !isStudyTab(tab)) return <NotFoundPage />;
  if (state.status === 'missing') return <NotFoundPage />;
  if (state.status === 'error')
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center md:px-8">
        <div
          role="alert"
          className="mx-auto max-w-[28rem] rounded-xl border border-red-200 bg-red-50 p-6"
        >
          <p className="text-sm font-medium text-red-800">The study couldn’t be loaded.</p>
          <p className="mt-1 text-xs text-red-700">
            The gateway didn’t answer for this study. This says nothing about your access.{' '}
            {state.message}
          </p>
          <button
            type="button"
            onClick={reload}
            className="mt-4 cursor-pointer rounded-lg border border-red-300 bg-tp-canvas px-4 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      </div>
    );
  if (!state.scope) return <CollectionCardSkeleton />;
  return (
    <CardBody key={`${org}/${slug}`} scope={state.scope} tab={tab as StudyTabId | undefined} />
  );
}
